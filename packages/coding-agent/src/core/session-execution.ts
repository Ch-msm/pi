import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { acquireSessionFileLock, canonicalSessionFile, type SessionFileLock } from "./session-file-lock.ts";
import { SessionManager } from "./session-manager.ts";

interface ExecutionLease {
	file: string;
	manager?: SessionManager;
	active: boolean;
	runtimeRecord?: string;
	runtimeLock?: SessionFileLock;
	agentDir?: string;
	lock: SessionFileLock;
}
const leases = new Map<string, ExecutionLease>();

function release(lease: ExecutionLease): void {
	if (leases.get(lease.file) !== lease) return;
	try {
		for (const file of [lease.runtimeRecord, `${lease.file}.execution-owner.json`]) {
			if (!file) continue;
			try {
				unlinkSync(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	} finally {
		try {
			lease.runtimeLock?.release();
		} finally {
			lease.lock.release();
			leases.delete(lease.file);
		}
	}
}

function reserve(path: string): ExecutionLease {
	const file = canonicalSessionFile(path);
	if (leases.has(file)) throw new Error("SESSION_IN_USE: 此会话已有执行实例，不能重复执行");
	const lease: ExecutionLease = { file, active: false, lock: acquireSessionFileLock(file) };
	leases.set(file, lease);
	return lease;
}

/** 为执行打开历史，在迁移或构造之前取得独占锁；普通只读浏览应使用 readSessionHistory。 */
export function openSessionForExecution(
	path: string,
	sessionDir?: string,
	cwdOverride?: string,
	previous?: SessionManager,
	prepare?: () => void,
): SessionManager {
	const file = canonicalSessionFile(path),
		owned = leases.get(file);
	if (owned && owned.manager === previous && previous !== undefined) {
		return owned.lock.run(() => {
			prepare?.();
			return SessionManager.open(file, sessionDir, cwdOverride);
		});
	}
	const lease = reserve(file);
	try {
		const manager = lease.lock.run(() => {
			prepare?.();
			return SessionManager.open(lease.file, sessionDir, cwdOverride);
		});
		lease.manager = manager;
		return manager;
	} catch (error) {
		release(lease);
		throw error;
	}
}

/** SDK 创建 Agent 前调用；会话资源销毁时同步释放，进程退出也由锁库清理。 */
export function activateSessionExecution(manager: SessionManager, agentDir = getAgentDir()): () => void {
	if (!manager.isPersisted()) return () => {};
	const path = manager.getSessionFile();
	if (!path) throw new Error("持久会话缺少文件路径");
	const file = canonicalSessionFile(path),
		existing = leases.get(file);
	const lease = existing ?? reserve(file);
	if (lease.active || (lease.manager && lease.manager !== manager))
		throw new Error("SESSION_IN_USE: 此会话已有执行实例");
	lease.manager = manager;
	lease.active = true;
	lease.agentDir = agentDir;
	return () => release(lease);
}

/** 只释放当前管理器持有的预留或执行锁，不允许释放其他实例。 */
export function releaseSessionExecution(manager: SessionManager): void {
	for (const lease of leases.values()) if (lease.manager === manager) release(lease);
}

/** 扩展在注册当前执行实例时发布归属，宿主只能复用这份持锁实例的身份。 */
export function publishSessionExecution(path: string, source: string, runtimeId: string, sessionId: string): void {
	const file = canonicalSessionFile(path),
		lease = leases.get(file);
	if (!lease?.active || lease.manager?.getSessionId() !== sessionId) throw new Error("会话没有当前进程的执行锁");
	if (!/^[a-f0-9]{64}$/.test(source) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runtimeId))
		throw new Error("执行实例身份无效");
	const directory = join(lease.agentDir!, "execution-runtimes");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (!lstatSync(directory).isDirectory()) throw new Error("执行归属目录不能是符号链接");
	chmodSync(directory, 0o700);
	const runtimeRecord = join(directory, `${createHash("sha256").update(runtimeId).digest("hex")}.json`);
	if (lease.runtimeRecord && lease.runtimeRecord !== runtimeRecord) throw new Error("执行实例身份发布后不能变更");
	// 归属记录与会话文件分别持锁，避免不同会话（含其他进程）抢占相同 runtimeId。
	const runtimeLock = lease.runtimeLock ?? acquireSessionFileLock(runtimeRecord);
	try {
		const data = JSON.stringify({ version: 1, file, source, runtimeId, sessionId, pid: process.pid });
		for (const target of [`${file}.execution-owner.json`, runtimeRecord]) {
			const temporary = `${target}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
				renameSync(temporary, target);
			} finally {
				rmSync(temporary, { force: true });
			}
		}
		lease.runtimeRecord = runtimeRecord;
		lease.runtimeLock = runtimeLock;
	} catch (error) {
		if (!lease.runtimeLock) runtimeLock.release();
		throw error;
	}
}
