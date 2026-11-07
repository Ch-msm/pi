import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.ts";

const initial = {
	defaultProvider: "chat-provider",
	defaultModel: "chat-model",
	theme: "dark",
	compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 10000, model: "old/summary" },
};
const selected = "selected/summary";

function readSettings(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("压缩模型配置持久化", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let globalPath: string;
	let projectPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-compaction-settings-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir);
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		globalPath = join(agentDir, "settings.json");
		projectPath = join(projectDir, ".pi", "settings.json");
		writeFileSync(globalPath, JSON.stringify(initial));
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	test("写入全局配置后重建设置管理器仍使用新模型，聊天默认值及其他参数不变", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		await manager.setCompactionModel(selected);

		expect(readSettings(globalPath)).toEqual({
			...initial,
			compaction: { ...initial.compaction, model: selected },
		});
		expect(manager.getCompactionModel()).toBe(selected);
		expect(manager.getDefaultModel()).toBe(initial.defaultModel);
		expect(manager.getDefaultProvider()).toBe(initial.defaultProvider);
		expect(SettingsManager.create(projectDir, agentDir).getCompactionModel()).toBe(selected);
	});

	test("仅写模型字段，保留文件中外部新增及修改的同级设置", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		const external = {
			...initial,
			theme: "light",
			enabledModels: ["external/model"],
			compaction: { ...initial.compaction, keepRecentTokens: 20000 },
		};
		writeFileSync(globalPath, JSON.stringify(external));
		await manager.setCompactionModel(selected);

		expect(readSettings(globalPath)).toEqual({
			...external,
			compaction: { ...external.compaction, model: selected },
		});
	});

	test("项目级模型字段不生效，只更新全局模型并保留项目文件及 token 参数", async () => {
		const project = { compaction: { model: "project/old", keepRecentTokens: 5000 }, theme: "project-theme" };
		writeFileSync(projectPath, JSON.stringify(project));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getCompactionModel()).toBe(initial.compaction.model);
		await manager.setCompactionModel(selected);

		expect(readSettings(projectPath)).toEqual(project);
		expect(readSettings(globalPath)).toEqual({ ...initial, compaction: { ...initial.compaction, model: selected } });
		expect(manager.getCompactionModel()).toBe(selected);
		expect(manager.getCompactionKeepRecentTokens()).toBe(5000);
		expect(SettingsManager.create(projectDir, agentDir).getCompactionModel()).toBe(selected);
	});

	test("项目仅覆盖 token 参数时仍将模型保存到全局，不更改项目参数", async () => {
		const project = { compaction: { keepRecentTokens: 5000 } };
		writeFileSync(projectPath, JSON.stringify(project));
		const manager = SettingsManager.create(projectDir, agentDir);
		await manager.setCompactionModel(selected);

		expect(readSettings(globalPath)).toMatchObject({ compaction: { model: selected } });
		expect(readSettings(projectPath)).toEqual(project);
		expect(manager.getCompactionKeepRecentTokens()).toBe(5000);
		expect(SettingsManager.create(projectDir, agentDir).getCompactionModel()).toBe(selected);
	});

	test("不信任项目时只更新全局，不读取或写入项目覆盖", async () => {
		const project = { compaction: { model: "untrusted/summary" } };
		writeFileSync(projectPath, JSON.stringify(project));
		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
		await manager.setCompactionModel(selected);

		expect(readSettings(projectPath)).toEqual(project);
		expect(readSettings(globalPath)).toMatchObject({ compaction: { model: selected } });
		expect(manager.getCompactionModel()).toBe(selected);
	});

	test("排队期间撤销项目信任不影响全局模型写入，也不修改项目文件", async () => {
		const project = { compaction: { model: "project/old" } };
		writeFileSync(projectPath, JSON.stringify(project));
		const manager = SettingsManager.create(projectDir, agentDir);
		const saving = manager.setCompactionModel(selected);
		manager.setProjectTrusted(false);

		await saving;
		expect(manager.getCompactionModel()).toBe(selected);
		expect(readSettings(projectPath)).toEqual(project);
		expect(readSettings(globalPath)).toMatchObject({ compaction: { model: selected } });
	});

	test("仅项目声明压缩模型时视为没有全局模型，不继承项目选择", () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		writeFileSync(projectPath, JSON.stringify({ compaction: { model: "project/ignored", keepRecentTokens: 5000 } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getCompactionModel()).toBeUndefined();
		expect(manager.getCompactionKeepRecentTokens()).toBe(5000);
	});

	test("运行期间新增项目级模型不覆盖全局选择，重新加载和重建后均一致", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		const project = { compaction: { model: "project/ignored", keepRecentTokens: 5000 } };
		writeFileSync(projectPath, JSON.stringify(project));
		await manager.setCompactionModel(selected);
		await manager.reload();

		expect(manager.getCompactionModel()).toBe(selected);
		expect(SettingsManager.create(projectDir, agentDir).getCompactionModel()).toBe(selected);
		expect(readSettings(projectPath)).toEqual(project);
	});

	test("与配置重载并发后，保存其他设置也不会回退到项目模型", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(projectPath, JSON.stringify({ compaction: { model: "project/ignored" } }));
		await Promise.all([manager.reload(), manager.setCompactionModel(selected)]);
		manager.setTheme("light");
		await manager.flush();

		expect(manager.getCompactionModel()).toBe(selected);
		expect(SettingsManager.create(projectDir, agentDir).getCompactionModel()).toBe(selected);
	});

	test("切换项目信任时始终使用同一个全局压缩模型", async () => {
		writeFileSync(projectPath, JSON.stringify({ compaction: { model: "project/ignored", keepRecentTokens: 5000 } }));
		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
		const saving = manager.setCompactionModel(selected);
		manager.setProjectTrusted(true);
		await saving;
		manager.setTheme("light");
		await manager.flush();

		expect(manager.getCompactionModel()).toBe(selected);
		expect(manager.getCompactionKeepRecentTokens()).toBe(5000);
		manager.setProjectTrusted(false);
		expect(manager.getCompactionModel()).toBe(selected);
	});

	test("不同项目共用全局压缩模型，各自的项目字段都不能覆盖它", async () => {
		const otherProjectDir = join(tempDir, "other-project");
		mkdirSync(join(otherProjectDir, ".pi"), { recursive: true });
		writeFileSync(projectPath, JSON.stringify({ compaction: { model: "project/ignored" } }));
		writeFileSync(
			join(otherProjectDir, ".pi", "settings.json"),
			JSON.stringify({ compaction: { model: "other/ignored", keepRecentTokens: 5000 } }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);
		const other = SettingsManager.create(otherProjectDir, agentDir);
		await manager.setCompactionModel(selected);
		await other.reload();

		expect(manager.getCompactionModel()).toBe(selected);
		expect(other.getCompactionModel()).toBe(selected);
		expect(other.getCompactionKeepRecentTokens()).toBe(5000);
	});

	test("配置写入失败时保留原内存默认值，修复存储后可继续保存", async () => {
		let content = JSON.stringify(initial);
		let failWrites = true;
		const storage: SettingsStorage = {
			withLock(scope, update) {
				const next = update(scope === "global" ? content : undefined);
				if (next === undefined) return;
				if (failWrites) throw new Error("配置不可写");
				if (scope === "global") content = next;
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		await expect(manager.setCompactionModel(selected)).rejects.toThrow("配置不可写");
		expect(manager.getCompactionModel()).toBe(initial.compaction.model);
		expect(JSON.parse(content)).toEqual(initial);
		await manager.flush();
		expect(manager.drainErrors()).toMatchObject([{ scope: "global", error: { message: "配置不可写" } }]);

		failWrites = false;
		await manager.setCompactionModel(selected);
		expect(manager.getCompactionModel()).toBe(selected);
		expect(JSON.parse(content)).toMatchObject({ compaction: { model: selected } });
	});

	test("配置文件被外部改坏时报告错误，不覆盖文件也不切换内存默认值", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(globalPath, "{invalid json");
		await expect(manager.setCompactionModel(selected)).rejects.toThrow();

		expect(readFileSync(globalPath, "utf8")).toBe("{invalid json");
		expect(manager.getCompactionModel()).toBe(initial.compaction.model);
	});

	test("连续切换按写入顺序保存，最后一次选择生效", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		await Promise.all([manager.setCompactionModel("first/summary"), manager.setCompactionModel(selected)]);

		expect(manager.getCompactionModel()).toBe(selected);
		expect(readSettings(globalPath)).toMatchObject({ compaction: { model: selected } });
	});

	test("与其他压缩设置写入交错时不覆盖模型或 token 参数", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		const saving = manager.setCompactionModel(selected);
		manager.setCompactionEnabled(false);
		await saving;
		await manager.flush();

		expect(readSettings(globalPath)).toEqual({
			...initial,
			compaction: { ...initial.compaction, model: selected, enabled: false },
		});
		expect(manager.getCompactionSettings()).toEqual({ ...initial.compaction, model: selected, enabled: false });
	});
});
