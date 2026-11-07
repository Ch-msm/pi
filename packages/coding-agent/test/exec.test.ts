import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { execCommand } from "../src/core/exec.ts";

// 只执行短生命周期的 Node 测试进程，不启动 Pi 或真实服务。
describe("execCommand", () => {
	test("正常退出保留输出且不标记为终止", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", 'process.stdout.write("completed"); process.stderr.write("diagnostic");'],
			tmpdir(),
		);
		expect(result).toEqual({ code: 0, killed: false, stdout: "completed", stderr: "diagnostic" });
	});

	test("正常非零退出保留原退出码", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exitCode = 7;"], tmpdir());
		expect(result.code).toBe(7);
		expect(result.killed).toBe(false);
	});

	test.skipIf(process.platform === "win32").each(["SIGTERM", "SIGKILL"] as const)(
		"外部 %s 终止不能被视为成功",
		async (signal) => {
			const result = await execCommand(
				process.execPath,
				["-e", "process.kill(process.pid, process.argv[1]);", signal],
				tmpdir(),
			);
			expect(result.code).not.toBe(0);
			expect(result.killed).toBe(true);
			expect(result.stdout).toBe("");
		},
	);

	test("命令不存在时返回失败状态", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-exec-missing-"));
		try {
			const result = await execCommand(join(directory, "missing-executable"), [], directory);
			expect(result.code).not.toBe(0);
			expect(result.killed).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("主动取消仍标记为终止且返回失败状态", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000);"], tmpdir(), {
			signal: controller.signal,
		});
		expect(result.code).not.toBe(0);
		expect(result.killed).toBe(true);
	});
});
