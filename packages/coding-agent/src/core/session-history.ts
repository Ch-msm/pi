import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import {
	assertValidSessionId,
	type FileEntry,
	getDefaultSessionDir,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "./session-manager.ts";

export interface SessionHistoryOptions {
	before?: number;
	revision?: string;
	limit?: number;
	maxBytes?: number;
	cacheDir?: string;
}
export interface SessionHistoryPage {
	header: SessionHeader;
	name?: string;
	revision: string;
	entries: SessionEntry[];
	start: number;
	total: number;
	/** 实际读取正文的字节数，包括本次发生的索引重建。 */
	bytesRead: number;
	indexRebuilt: boolean;
}
type Position = [id: string, parent: string | null, offset: number, length: number];
interface HistoryIndex {
	version: 1;
	revision: string;
	header: SessionHeader;
	name?: string;
	positions: Position[];
	branch: number[];
}
/** 只读正式首行，不恢复 Agent 或读取整段历史。 */
export async function readSessionHeader(path: string): Promise<SessionHeader> {
	const parts: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of createReadStream(resolvePath(path), { highWaterMark: 4096 })) {
		const buffer = chunk as Buffer,
			end = buffer.indexOf(10),
			part = end < 0 ? buffer : buffer.subarray(0, end);
		parts.push(part);
		bytes += part.length;
		if (bytes > 1024 * 1024) throw new Error("会话头超过一 MiB 限制");
		if (end >= 0) break;
	}
	const header = entry(Buffer.concat(parts, bytes));
	if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
		throw new Error("历史会话头无效");
	return header;
}

/** 用户明确新建历史时，原子创建 SDK 会话头；相同标识重试不会覆盖既有历史。 */
export async function createSessionHistory(cwd: string, id: string, sessionDir?: string): Promise<string> {
	assertValidSessionId(id);
	const directory = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
	const manager = SessionManager.create(cwd, directory, { id });
	const path = resolve(directory, `remote_${id}.jsonl`),
		temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(manager.getHeader())}\n`, { mode: 0o600, flag: "wx" });
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const header = await readSessionHeader(path);
		if (header.id !== id || header.cwd !== manager.getCwd()) throw new Error("会话标识与既有历史不一致，未覆盖");
		return path;
	} finally {
		await rm(temporary, { force: true });
	}
}

const pending = new Map<string, Promise<HistoryIndex>>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function fileRevision(file: string) {
	const info = await stat(file, { bigint: true });
	if (!info.isFile()) throw new Error("历史路径不是普通文件");
	return {
		revision: digest(JSON.stringify([file, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String))),
		size: Number(info.size),
	};
}

function entry(line: Buffer): FileEntry | undefined {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
	if (!text.trim()) return;
	try {
		const value: unknown = JSON.parse(text);
		if (value && typeof value === "object" && "type" in value && typeof value.type === "string")
			return value as FileEntry;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
	return;
}

/** 只保存分支关系和精确字节位置，不把历史正文复制到索引中。 */
async function buildIndex(file: string, revision: string): Promise<HistoryIndex> {
	const positions: Position[] = [];
	let header: SessionHeader | undefined,
		name: string | undefined,
		offset = 0;
	let pieces: Buffer[] = [],
		pieceBytes = 0;
	const accept = (line: Buffer, at: number) => {
		const value = entry(line);
		if (!value) return;
		if (!header) {
			if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string")
				throw new Error("历史会话头无效");
			if (![1, 2, 3].includes(value.version ?? 1)) throw new Error("不支持的历史版本");
			header = value;
			return;
		}
		if (value.type === "session") return;
		const legacy = (header.version ?? 1) === 1;
		const id = legacy ? `legacy-${at}` : value.id;
		const parent = legacy ? (positions.at(-1)?.[0] ?? null) : value.parentId;
		if (typeof id !== "string" || (parent !== null && typeof parent !== "string"))
			throw new Error("历史条目标识无效");
		positions.push([id, parent, at, line.length]);
		if (value.type === "session_info" && typeof value.name === "string")
			name = value.name.trim().slice(0, 200) || undefined;
	};
	for await (const chunk of createReadStream(file)) {
		const buffer = chunk as Buffer;
		let start = 0;
		for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
			const part = buffer.subarray(start, end);
			const line = pieces.length ? Buffer.concat([...pieces, part], pieceBytes + part.length) : part;
			accept(line, offset);
			offset += line.length + 1;
			pieces = [];
			pieceBytes = 0;
			start = end + 1;
		}
		if (start < buffer.length) {
			const tail = buffer.subarray(start);
			pieces.push(tail);
			pieceBytes += tail.length;
		}
	}
	if (pieceBytes) accept(Buffer.concat(pieces, pieceBytes), offset);
	if (!header) throw new Error("历史会话头无效");
	const byId = new Map(positions.map((position, index) => [position[0], index]));
	if (byId.size !== positions.length) throw new Error("历史包含重复条目标识");
	const branch: number[] = [],
		seen = new Set<number>();
	let current: number | undefined = positions.length ? positions.length - 1 : undefined;
	while (current !== undefined) {
		if (seen.has(current)) throw new Error("历史父链存在循环");
		seen.add(current);
		branch.push(current);
		const parent: string | null = positions[current][1];
		current = parent === null ? undefined : byId.get(parent);
		if (parent !== null && current === undefined) throw new Error("历史父链缺失");
	}
	branch.reverse();
	if ((await fileRevision(file)).revision !== revision) throw new Error("HISTORY_CHANGED: 建立索引期间历史发生变化");
	return { version: 1, revision, header, name, positions, branch };
}

function validIndex(value: unknown, revision: string, size: number): value is HistoryIndex {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<HistoryIndex>;
	if (
		v.version !== 1 ||
		v.revision !== revision ||
		v.header?.type !== "session" ||
		typeof v.header.id !== "string" ||
		!Array.isArray(v.positions) ||
		!Array.isArray(v.branch)
	)
		return false;
	if (
		!v.positions.every(
			(p) =>
				Array.isArray(p) &&
				p.length === 4 &&
				typeof p[0] === "string" &&
				(p[1] === null || typeof p[1] === "string") &&
				Number.isSafeInteger(p[2]) &&
				p[2] >= 0 &&
				Number.isSafeInteger(p[3]) &&
				p[3] > 0 &&
				p[2] + p[3] <= size,
		)
	)
		return false;
	const positions = v.positions;
	if (new Set(positions.map((p) => p[0])).size !== positions.length || new Set(v.branch).size !== v.branch.length)
		return false;
	return (
		v.branch.every(
			(index, n) =>
				Number.isSafeInteger(index) &&
				index >= 0 &&
				index < positions.length &&
				positions[index][1] === (n ? positions[v.branch![n - 1]][0] : null),
		) && (v.branch.length === 0 ? positions.length === 0 : v.branch.at(-1) === positions.length - 1)
	);
}

async function loadIndex(file: string, cacheDir: string, revision: string, size: number) {
	await mkdir(cacheDir, { recursive: true, mode: 0o700 });
	if (!(await lstat(cacheDir)).isDirectory()) throw new Error("历史索引目录不能是符号链接");
	await chmod(cacheDir, 0o700);
	const cached = join(cacheDir, `${digest(file)}.json`);
	try {
		const info = await lstat(cached);
		if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("历史索引必须是私有普通文件");
		const value: unknown = JSON.parse(await readFile(cached, "utf8"));
		if (validIndex(value, revision, size)) return { index: value, rebuilt: false };
	} catch (error) {
		if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const key = JSON.stringify([file, cacheDir, revision]);
	let task = pending.get(key);
	if (!task) {
		task = (async () => {
			const index = await buildIndex(file, revision),
				temporary = `${cached}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(index), { mode: 0o600, flag: "wx" });
				if ((await fileRevision(file)).revision !== revision) throw new Error("HISTORY_CHANGED: 历史发生变化");
				await rename(temporary, cached);
			} finally {
				await unlink(temporary).catch((error) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
			return index;
		})();
		pending.set(key, task);
	}
	try {
		return { index: await task, rebuilt: true };
	} finally {
		if (pending.get(key) === task) pending.delete(key);
	}
}

/** 按落盘分支读取最后一页或指定版本的更早页，不创建 Agent、不迁移或改写会话。 */
export async function readSessionHistory(
	path: string,
	options: SessionHistoryOptions = {},
): Promise<SessionHistoryPage> {
	const file = await realpath(resolvePath(path));
	const limit = options.limit ?? 30,
		maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 16 * 1024 * 1024
	)
		throw new Error("历史页大小无效");
	if (
		options.before !== undefined &&
		(!Number.isSafeInteger(options.before) || options.before < 0 || !options.revision)
	)
		throw new Error("历史页游标无效");
	const { revision, size } = await fileRevision(file);
	if (options.revision !== undefined && options.revision !== revision)
		throw new Error("HISTORY_CHANGED: 历史版本已变化，请重新加载");
	const { index, rebuilt } = await loadIndex(
		file,
		options.cacheDir ?? join(getAgentDir(), "cache", "history-pages-v1"),
		revision,
		size,
	);
	const end = options.before ?? index.branch.length;
	if (end > index.branch.length) throw new Error("历史页游标越界");
	const entries: SessionEntry[] = [];
	let start = end,
		bytes = 0;
	const handle = await open(file, "r");
	try {
		while (start > 0 && entries.length < limit) {
			const position = index.positions[index.branch[start - 1]],
				[id, parent, offset, length] = position;
			if (bytes + length > maxBytes) {
				if (!entries.length) throw new Error("ENTRY_TOO_LARGE: 单条历史超过读取预算，正文未截断");
				break;
			}
			const buffer = Buffer.alloc(length);
			let read = 0;
			while (read < length) {
				const part = await handle.read(buffer, read, length - read, offset + read);
				if (!part.bytesRead) throw new Error("HISTORY_CHANGED: 历史读取不完整");
				read += part.bytesRead;
			}
			const value = entry(buffer);
			if (!value || value.type === "session") throw new Error("历史索引条目无效");
			if ((index.header.version ?? 1) === 1) {
				value.id = id;
				value.parentId = parent;
			}
			if (value.id !== id || value.parentId !== parent) throw new Error("历史索引与正文不一致");
			if ((index.header.version ?? 1) < 3 && value.type === "message") {
				const message = value.message as { role: string };
				if (message.role === "hookMessage") message.role = "custom";
			}
			entries.unshift(value);
			bytes += length;
			start--;
		}
		if ((await fileRevision(file)).revision !== revision) throw new Error("HISTORY_CHANGED: 读取期间历史发生变化");
	} finally {
		await handle.close();
	}
	return {
		header: index.header,
		name: index.name,
		revision,
		entries,
		start,
		total: index.branch.length,
		bytesRead: bytes + (rebuilt ? size : 0),
		indexRebuilt: rebuilt,
	};
}
