import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionHistory, readSessionHeader, readSessionHistory } from "../../src/core/session-history.ts";

describe("只读历史分页", () => {
	let root: string;
	let file: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-history-page-"));
		file = join(root, "history.jsonl");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	function seed(count = 75) {
		const values: object[] = [
			{ type: "session", version: 3, id: "history", cwd: root, timestamp: "2024-01-01T00:00:00Z" },
		];
		for (let n = 0; n < count; n++)
			values.push({
				type: "message",
				id: `m${n}`,
				parentId: n ? `m${n - 1}` : null,
				timestamp: "2024-01-01T00:00:00Z",
				message: { role: "user", content: `消息 ${n}`, timestamp: n },
			});
		writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
	}
	const options = () => ({ cacheDir: join(root, "cache") });

	it("按末尾 30 条读取并向前翻页，不改写历史", async () => {
		seed();
		const before = readFileSync(file);
		const time = statSync(file).mtimeMs;
		const one = await readSessionHistory(file, options());
		expect(one.entries.map((entry) => entry.id)).toEqual(Array.from({ length: 30 }, (_, i) => `m${i + 45}`));
		expect(one.start).toBe(45);
		expect(one.total).toBe(75);
		const two = await readSessionHistory(file, { ...options(), before: one.start, revision: one.revision });
		const three = await readSessionHistory(file, { ...options(), before: two.start, revision: two.revision });
		expect(two.entries.map((entry) => entry.id)).toEqual(Array.from({ length: 30 }, (_, i) => `m${i + 15}`));
		expect(three.entries.map((entry) => entry.id)).toEqual(Array.from({ length: 15 }, (_, i) => `m${i}`));
		expect(three.start).toBe(0);
		expect(readFileSync(file)).toEqual(before);
		expect(statSync(file).mtimeMs).toBe(time);
	});

	it("只沿正式叶节点的父链读当前分支，不把另一分支混进来", async () => {
		seed(3);
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "message",
				id: "branch",
				parentId: "m0",
				timestamp: "2024-01-02T00:00:00Z",
				message: { role: "user", content: "另一分支", timestamp: 4 },
			})}\n`,
		);
		const page = await readSessionHistory(file, options());
		expect(page.entries.map((entry) => entry.id)).toEqual(["m0", "branch"]);
	});

	it("修改历史后拒绝旧页版本，不能混合两个快照", async () => {
		seed();
		const one = await readSessionHistory(file, options());
		appendFileSync(
			file,
			`${JSON.stringify({ type: "session_info", id: "name", parentId: "m74", name: "新名称", timestamp: "2024-01-02T00:00:00Z" })}\n`,
		);
		await expect(
			readSessionHistory(file, { ...options(), before: one.start, revision: one.revision }),
		).rejects.toThrow(/HISTORY_CHANGED/);
		const refreshed = await readSessionHistory(file, options());
		expect(refreshed.name).toBe("新名称");
		expect(refreshed.revision).not.toBe(one.revision);
	});

	it("缓存索引只存字节位置，后续页只读取该页正文", async () => {
		seed();
		const first = await readSessionHistory(file, options());
		const second = await readSessionHistory(file, { ...options(), before: first.start, revision: first.revision });
		expect(first.indexRebuilt).toBe(true);
		expect(second.indexRebuilt).toBe(false);
		expect(second.bytesRead).toBeLessThan(statSync(file).size / 2);
		expect(second.entries).toHaveLength(30);
	});

	it("单页原始字节预算不靠截断正文满足", async () => {
		seed(4);
		const first = await readSessionHistory(file, { ...options(), maxBytes: 200 });
		expect(first.entries).toHaveLength(1);
		expect(first.start).toBe(3);
		await expect(readSessionHistory(file, { ...options(), maxBytes: 10 })).rejects.toThrow(/ENTRY_TOO_LARGE/);
	});

	it("显式新建只原子写入正式会话头，重复请求保留已追加内容", async () => {
		const created = await createSessionHistory(root, "new-history", root);
		expect((await readSessionHeader(created)).id).toBe("new-history");
		expect((await readSessionHistory(created, options())).total).toBe(0);
		appendFileSync(
			created,
			`${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2024-01-01T00:00:00Z", message: { role: "user", content: "保留", timestamp: 1 } })}\n`,
		);
		const contents = readFileSync(created);
		expect(await createSessionHistory(root, "new-history", root)).toBe(created);
		expect(readFileSync(created)).toEqual(contents);
	});

	it("坏游标和损坏父链明确拒绝", async () => {
		seed(3);
		await expect(readSessionHistory(file, { ...options(), before: -1, revision: "x" })).rejects.toThrow();
		appendFileSync(
			file,
			`${JSON.stringify({ type: "session_info", id: "cycle", parentId: "cycle", name: "循环", timestamp: "2024-01-01T00:00:00Z" })}\n`,
		);
		await expect(readSessionHistory(file, options())).rejects.toThrow(/父链/);
	});
});
