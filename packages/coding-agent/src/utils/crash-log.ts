import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

/** 同步追加私有崩溃日志；调用方负责在写入失败时继续恢复终端。 */
export function appendCrashLog(error: unknown): void {
	const directory = getAgentDir();
	mkdirSync(directory, { recursive: true });
	const descriptor = openSync(
		join(directory, "pi-errors.log"),
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600,
	);
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error("崩溃日志必须是普通文件");
		// 同时收紧已有日志的权限；通过描述符操作，避免检查与写入之间替换路径。
		fchmodSync(descriptor, 0o600);
		const stack = error instanceof Error ? (error.stack ?? String(error)) : String(error);
		// 不记录命令行原文，避免将 API Key、提示词和扩展参数中的凭据落盘。
		appendFileSync(
			descriptor,
			`[${new Date().toISOString()}] uncaughtException (pid=${process.pid}, cwd=${process.cwd()})\n${stack}\n\n`,
		);
	} finally {
		closeSync(descriptor);
	}
}
