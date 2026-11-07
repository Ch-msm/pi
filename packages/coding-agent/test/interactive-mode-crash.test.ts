import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { appendCrashLog } from "../src/utils/crash-log.ts";
import * as shell from "../src/utils/shell.ts";

let root: string;
let directory: string;
let logPath: string;
const originalArgv = process.argv;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-crash-log-test-"));
	directory = join(root, "custom-agent");
	logPath = join(directory, "pi-errors.log");
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});

afterEach(() => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("appendCrashLog", () => {
	test("在自定义 agent 目录创建私有日志，保留诊断信息但不记录命令行原文", () => {
		process.argv = [
			process.execPath,
			"pi",
			"--api-key",
			"private-key-separated",
			"--api-key=private-key-inline",
			"--system-prompt",
			"private-system-prompt",
			"private-user-prompt",
		];
		const error = new Error("测试异常");
		error.stack = "Error: 测试异常\n    at crash-regression.ts:10:2";

		appendCrashLog(error);

		const content = readFileSync(logPath, "utf8");
		expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/);
		expect(content).toContain(`uncaughtException (pid=${process.pid}, cwd=${process.cwd()})`);
		expect(content).toContain(error.stack);
		for (const argument of process.argv.slice(2)) expect(content).not.toContain(argument);
		if (process.platform !== "win32") expect(statSync(logPath).mode & 0o777).toBe(0o600);
	});

	test.skipIf(process.platform === "win32")("收紧已有日志权限且保留历史记录", () => {
		mkdirSync(directory, { recursive: true });
		writeFileSync(logPath, "已有记录\n");
		chmodSync(logPath, 0o664);

		appendCrashLog(new Error("新增异常"));

		expect(statSync(logPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(logPath, "utf8")).toMatch(/^已有记录\n\[/);
		expect(readFileSync(logPath, "utf8")).toContain("Error: 新增异常");
	});

	test("连续追加不截断旧日志，非 Error 异常也可记录", () => {
		appendCrashLog(new Error("第一次异常"));
		const previous = readFileSync(logPath, "utf8");
		appendCrashLog("非 Error 异常");
		const content = readFileSync(logPath, "utf8");
		expect(content.startsWith(previous)).toBe(true);
		expect(content).toContain("非 Error 异常\n\n");
		expect(content.match(/uncaughtException/g)).toHaveLength(2);
	});

	test.skipIf(process.platform === "win32")("拒绝符号链接，不改写目标内容或权限", () => {
		mkdirSync(directory, { recursive: true });
		const target = join(root, "other.txt");
		writeFileSync(target, "不能改写的文件");
		chmodSync(target, 0o644);
		symlinkSync(target, logPath);

		expect(() => appendCrashLog(new Error("测试异常"))).toThrow();
		expect(readFileSync(target, "utf8")).toBe("不能改写的文件");
		expect(statSync(target).mode & 0o777).toBe(0o644);
	});
});

type CrashContext = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	ui: { stop: () => void };
};
const uncaughtCrash = Reflect.get(InteractiveMode.prototype, "uncaughtCrash") as (
	this: CrashContext,
	error: Error,
) => never;

describe("InteractiveMode.uncaughtCrash", () => {
	for (const writable of [true, false]) {
		test(`日志${writable ? "写入成功" : "写入失败"}均恢复终端并退出`, () => {
			if (!writable) mkdirSync(logPath, { recursive: true });
			const exit = new Error("拦截测试退出，不启动真实 Pi 进程");
			const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
				throw exit;
			});
			const killSpy = vi.spyOn(shell, "killTrackedDetachedChildren").mockImplementation(() => {});
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const context: CrashContext = {
				isShuttingDown: false,
				unregisterSignalHandlers: vi.fn(),
				ui: { stop: vi.fn() },
			};
			const error = new Error("测试崩溃");

			expect(() => uncaughtCrash.call(context, error)).toThrow(exit);

			expect(context.isShuttingDown).toBe(true);
			expect(context.unregisterSignalHandlers).toHaveBeenCalledOnce();
			expect(killSpy).toHaveBeenCalledOnce();
			expect(context.ui.stop).toHaveBeenCalledOnce();
			expect(consoleSpy).toHaveBeenCalledWith(error);
			expect(exitSpy).toHaveBeenCalledWith(1);
			if (writable) expect(readFileSync(logPath, "utf8")).toContain("Error: 测试崩溃");
		});
	}

	test("重复崩溃直接退出，不再次写日志或恢复终端", () => {
		const exit = new Error("拦截测试退出");
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw exit;
		});
		const killSpy = vi.spyOn(shell, "killTrackedDetachedChildren").mockImplementation(() => {});
		const context: CrashContext = {
			isShuttingDown: true,
			unregisterSignalHandlers: vi.fn(),
			ui: { stop: vi.fn() },
		};

		expect(() => uncaughtCrash.call(context, new Error("重复崩溃"))).toThrow(exit);

		expect(existsSync(logPath)).toBe(false);
		expect(context.unregisterSignalHandlers).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();
		expect(context.ui.stop).not.toHaveBeenCalled();
	});
});
