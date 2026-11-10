import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { resolvePath } from "../utils/paths.ts";

export interface SessionFileLock {
	file: string;
	/** 仅在同步打开过程中复用持锁者的权限，不向其他执行对象开放重入。 */
	run<T>(action: () => T): T;
	release(): void;
}

const openingLocks = new Map<string, SessionFileLock>();

export function canonicalSessionFile(path: string): string {
	const file = resolvePath(path);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	return existsSync(file)
		? realpathSync(file)
		: resolve(realpathSync(dirname(file)), file.slice(dirname(file).length + 1));
}

export function acquireSessionFileLock(path: string): SessionFileLock {
	const file = canonicalSessionFile(path);
	let unlock: () => void;
	try {
		// 异常退出遗留锁要求人工确认，不基于心跳过期抢锁。
		unlock = lockfile.lockSync(file, {
			realpath: false,
			lockfilePath: `${file}.execution.lock`,
			stale: Infinity,
			update: 60_000,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED")
			throw new Error("SESSION_IN_USE: 此会话被另一执行实例占用；异常退出的遗留锁需人工核对");
		throw error;
	}
	try {
		chmodSync(`${file}.execution.lock`, 0o700);
	} catch (error) {
		unlock();
		throw error;
	}
	let released = false;
	const lock: SessionFileLock = {
		file,
		run<T>(action: () => T): T {
			if (released) throw new Error("会话文件锁已释放");
			const previous = openingLocks.get(file);
			openingLocks.set(file, lock);
			try {
				return action();
			} finally {
				if (previous) openingLocks.set(file, previous);
				else openingLocks.delete(file);
			}
		},
		release() {
			if (released) return;
			unlock();
			released = true;
		},
	};
	return lock;
}

/** 普通打开临时持锁；执行入口仅在自身的同步打开作用域内复用预留锁。 */
export function withSessionFileLock<T>(path: string, action: () => T): T {
	const file = canonicalSessionFile(path);
	if (openingLocks.has(file)) return action();
	const lock = acquireSessionFileLock(file);
	try {
		return lock.run(action);
	} finally {
		lock.release();
	}
}
