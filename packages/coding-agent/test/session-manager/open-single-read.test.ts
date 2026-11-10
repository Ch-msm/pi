import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof fs>("fs");
	return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});

describe("打开会话只读取一次完整历史", () => {
	let directory: string;
	let file: string;
	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-single-read-"));
		file = join(directory, "session.jsonl");
		vi.clearAllMocks();
	});
	afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

	function seed(text = "原始消息", version = 3) {
		const entries = [
			{ type: "session", version, id: "session-id", cwd: directory, timestamp: "2024-01-01T00:00:00Z" },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2024-01-01T00:00:01Z",
				message: { role: "user", content: text, timestamp: 1 },
			},
		];
		fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		return entries;
	}

	function assertReadOnce(bytes: number) {
		expect(vi.mocked(fs.openSync).mock.calls.filter(([path, flags]) => path === file && flags === "r")).toHaveLength(
			1,
		);
		expect(
			vi
				.mocked(fs.readSync)
				.mock.results.reduce((sum, result) => sum + (result.type === "return" ? result.value : 0), 0),
		).toBe(bytes);
	}

	it("跨读取块的 UTF-8 正文只解析一遍，并保留上下文及正式标识", () => {
		const text = "中文🙂".repeat(180_000);
		const entries = seed(text);
		const bytes = fs.statSync(file).size;
		const manager = SessionManager.open(file);
		assertReadOnce(bytes);
		expect(manager.getCwd()).toBe(directory);
		expect(manager.getSessionDir()).toBe(directory);
		expect(manager.getSessionId()).toBe("session-id");
		expect(manager.getHeader()).toEqual(entries[0]);
		expect(manager.getEntries()).toEqual([entries[1]]);
		expect(manager.buildSessionContext().messages).toEqual([entries[1].message]);
	});

	it("cwd 和会话目录覆盖不触发二次读取，也不改写原始会话头", () => {
		seed();
		const original = fs.readFileSync(file, "utf8");
		const override = join(directory, "working"),
			custom = join(directory, "custom");
		const manager = SessionManager.open(file, custom, override);
		assertReadOnce(Buffer.byteLength(original));
		expect(manager.getCwd()).toBe(override);
		expect(manager.getSessionDir()).toBe(custom);
		expect(manager.getHeader()?.cwd).toBe(directory);
		expect(fs.readFileSync(file, "utf8")).toBe(original);
	});

	it("再次打开必须读取新追加的历史，不跨调用复用旧数据", () => {
		seed();
		const first = SessionManager.open(file);
		fs.appendFileSync(
			file,
			`${JSON.stringify({
				type: "session_info",
				id: "name",
				parentId: "m1",
				name: "新增名称",
				timestamp: "2024-01-02T00:00:00Z",
			})}\n`,
		);
		vi.clearAllMocks();
		const next = SessionManager.open(file);
		assertReadOnce(fs.statSync(file).size);
		expect(first.getSessionName()).toBeUndefined();
		expect(next.getSessionName()).toBe("新增名称");
		expect(next.getLeafId()).toBe("name");
	});

	it("旧版本迁移仍执行并落盘，但不为迁移重复读取源文件", () => {
		seed("旧版本正文", 1);
		const bytes = fs.statSync(file).size;
		const manager = SessionManager.open(file);
		assertReadOnce(bytes);
		expect(manager.getHeader()?.version).toBe(3);
		expect(manager.buildSessionContext().messages).toEqual([{ role: "user", content: "旧版本正文", timestamp: 1 }]);
		expect(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]).version).toBe(3);
	});

	it("空文件及无有效会话头的修复语义保持不变", () => {
		for (const contents of ["", "{broken\n", '{"type":"message","id":"orphan"}\n']) {
			fs.writeFileSync(file, contents);
			vi.clearAllMocks();
			const manager = SessionManager.open(file, directory, directory);
			assertReadOnce(Buffer.byteLength(contents));
			expect(manager.getSessionFile()).toBe(file);
			expect(manager.getHeader()?.version).toBe(3);
			expect(manager.getEntries()).toEqual([]);
			expect(JSON.parse(fs.readFileSync(file, "utf8")).type).toBe("session");
		}
	});

	it("不存在的路径保留延迟创建语义", () => {
		const manager = SessionManager.open(file, directory, directory);
		expect(manager.getSessionFile()).toBe(file);
		expect(fs.existsSync(file)).toBe(false);
		expect(vi.mocked(fs.openSync).mock.calls).toHaveLength(0);
	});
});
