import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import {
	openSessionForExecution,
	publishSessionExecution,
	releaseSessionExecution,
} from "../../src/core/session-execution.ts";
import { acquireSessionFileLock } from "../../src/core/session-file-lock.ts";
import { readSessionHistory } from "../../src/core/session-history.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("历史执行单写入锁", () => {
	let root: string;
	let file: string;
	const sessions: AgentSession[] = [];
	const managers: SessionManager[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-execution-lease-"));
		file = join(root, "session.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "leased", cwd: root, timestamp: "2024-01-01T00:00:00Z" })}\n`,
		);
	});
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const manager of managers.splice(0)) releaseSessionExecution(manager);
		rmSync(root, { recursive: true, force: true });
	});
	async function create(manager: SessionManager) {
		const result = await createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			sessionManager: manager,
			model: getModel("anthropic", "claude-sonnet-4-5"),
		});
		sessions.push(result.session);
		return result.session;
	}

	it("两个 SDK 执行实例不能同时写同一会话，销毁后可以重新执行", async () => {
		const first = await create(SessionManager.open(file));
		let failure: unknown;
		try {
			await create(SessionManager.open(file));
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/SESSION_IN_USE/);
		first.dispose();
		sessions.splice(sessions.indexOf(first), 1);
		const next = await create(SessionManager.open(file));
		expect(next.sessionId).toBe("leased");
	});

	it("为执行打开时在解析和迁移前拒绝另一进程，不改变原文件", () => {
		const manager = openSessionForExecution(file);
		managers.push(manager);
		const original = readFileSync(file);
		const script = join(root, "contender.mjs");
		writeFileSync(
			script,
			`import { openSessionForExecution } from ${JSON.stringify(new URL("../../src/core/session-execution.ts", import.meta.url).href)};
try { openSessionForExecution(process.argv[2]); process.exitCode = 3; }
catch (error) { if (!String(error.message).includes('SESSION_IN_USE')) process.exitCode = 4; }
`,
		);
		const child = spawnSync(process.execPath, ["--experimental-strip-types", script, file], {
			env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
			encoding: "utf8",
		});
		expect(child.status, child.stderr).toBe(0);
		expect(readFileSync(file)).toEqual(original);
	});

	it("已持有的执行预留可被 SDK 接管，归属文件随销毁清理", async () => {
		const manager = openSessionForExecution(file);
		managers.push(manager);
		const session = await create(manager);
		publishSessionExecution(file, "a".repeat(64), "runtime-one", "leased");
		expect(JSON.parse(readFileSync(`${file}.execution-owner.json`, "utf8")).runtimeId).toBe("runtime-one");
		session.dispose();
		sessions.splice(sessions.indexOf(session), 1);
		expect(existsSync(`${file}.execution.lock`)).toBe(false);
		expect(existsSync(`${file}.execution-owner.json`)).toBe(false);
	});

	it("旧执行对象重复销毁不能释放新执行者的锁，即便复用同一个管理器", async () => {
		const manager = SessionManager.open(file),
			first = await create(manager);
		first.dispose();
		sessions.splice(sessions.indexOf(first), 1);
		await create(manager);
		first.dispose();
		expect(() => openSessionForExecution(file)).toThrow(/SESSION_IN_USE/);
	});

	it("旧打开入口在迁移或清理损坏文件前也必须取得执行锁", () => {
		for (const content of [
			`${JSON.stringify({ type: "session", version: 1, id: "legacy", cwd: root })}\n`,
			"损坏的会话\n",
		]) {
			writeFileSync(file, content);
			const lock = acquireSessionFileLock(file);
			try {
				expect(() => SessionManager.open(file)).toThrow(/SESSION_IN_USE/);
				const manager = SessionManager.create(root, root);
				expect(() => manager.setSessionFile(file)).toThrow(/SESSION_IN_USE/);
				expect(readFileSync(file, "utf8")).toBe(content);
			} finally {
				lock.release();
			}
			const manager = SessionManager.open(file);
			expect(manager.getHeader()?.version).toBe(3);
			expect(existsSync(`${file}.execution.lock`)).toBe(false);
		}
	});

	it("旧 SDK 打开入口在另一进程持锁时拒绝，不影响只读分页", async () => {
		const manager = openSessionForExecution(file);
		managers.push(manager);
		const script = join(root, "legacy-contender.mjs");
		writeFileSync(
			script,
			`import { SessionManager } from ${JSON.stringify(new URL("../../src/core/session-manager.ts", import.meta.url).href)};
try { SessionManager.open(process.argv[2]); process.exitCode = 3; }
catch (error) { if (!String(error.message).includes('SESSION_IN_USE')) process.exitCode = 4; }
`,
		);
		const child = spawnSync(process.execPath, ["--experimental-strip-types", script, file], { encoding: "utf8" });
		expect(child.status, child.stderr).toBe(0);
		const page = await readSessionHistory(file, { cacheDir: join(root, "cache") });
		expect(page.header.id).toBe("leased");
	});

	it("不同会话不能抢占相同 runtimeId，原持有者销毁后才允许复用", async () => {
		const first = await create(SessionManager.open(file));
		const second = await create(SessionManager.create(root, root));
		const secondFile = second.sessionFile!;
		const source = "a".repeat(64);
		const runtimeId = "shared-runtime";
		const record = join(
			root,
			"agent",
			"execution-runtimes",
			`${createHash("sha256").update(runtimeId).digest("hex")}.json`,
		);
		publishSessionExecution(file, source, runtimeId, first.sessionId);
		publishSessionExecution(file, source, runtimeId, first.sessionId);
		const original = readFileSync(record, "utf8");
		expect(() => publishSessionExecution(secondFile, source, runtimeId, second.sessionId)).toThrow(/SESSION_IN_USE/);
		expect(readFileSync(record, "utf8")).toBe(original);
		expect(existsSync(`${secondFile}.execution-owner.json`)).toBe(false);
		expect(() => publishSessionExecution(file, source, "another-runtime", first.sessionId)).toThrow(/不能变更/);
		first.dispose();
		publishSessionExecution(secondFile, source, runtimeId, second.sessionId);
		first.dispose();
		expect(JSON.parse(readFileSync(record, "utf8")).sessionId).toBe(second.sessionId);
		second.dispose();
		expect(existsSync(record)).toBe(false);
		expect(existsSync(`${record}.execution.lock`)).toBe(false);
	});

	it("另一进程不能覆盖当前持有者的 runtimeId 记录", async () => {
		const first = await create(SessionManager.open(file));
		const source = "a".repeat(64);
		publishSessionExecution(file, source, "shared-runtime", first.sessionId);
		const secondFile = join(root, "second.jsonl");
		writeFileSync(secondFile, `${JSON.stringify({ type: "session", version: 3, id: "second", cwd: root })}\n`);
		const script = join(root, "runtime-contender.mjs");
		writeFileSync(
			script,
			`import { openSessionForExecution, activateSessionExecution, publishSessionExecution } from ${JSON.stringify(new URL("../../src/core/session-execution.ts", import.meta.url).href)};
const manager = openSessionForExecution(process.argv[2]);
const release = activateSessionExecution(manager, process.argv[3]);
try { publishSessionExecution(process.argv[2], '${source}', 'shared-runtime', 'second'); process.exitCode = 3; }
catch (error) { if (!String(error.message).includes('SESSION_IN_USE')) process.exitCode = 4; }
finally { release(); }
`,
		);
		const owner = readFileSync(`${file}.execution-owner.json`, "utf8");
		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", script, secondFile, join(root, "agent")],
			{
				encoding: "utf8",
			},
		);
		expect(child.status, child.stderr).toBe(0);
		expect(readFileSync(`${file}.execution-owner.json`, "utf8")).toBe(owner);
		publishSessionExecution(file, source, "shared-runtime", first.sessionId);
	});

	it("内存会话不创建磁盘锁", async () => {
		await create(SessionManager.inMemory(root));
		expect(existsSync(`${file}.execution.lock`)).toBe(false);
	});
});
