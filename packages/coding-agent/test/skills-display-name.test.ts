import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSkillsForPrompt, loadSkillsFromDir } from "../src/core/skills.ts";

describe("技能显示名称", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-skill-display-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function load(extra: string = "") {
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: code-simplifier\ndescription: 精简代码\n${extra}---\n# 正文标题\n`,
		);
		return loadSkillsFromDir({ dir, source: "user" });
	}

	it("读取并规范显示名称，不改变标识和提示词协议", () => {
		const result = load('display-name: "  代码精简  "\n');
		expect(result.diagnostics).toEqual([]);
		expect(result.skills[0]).toMatchObject({ name: "code-simplifier", displayName: "代码精简" });
		expect(formatSkillsForPrompt(result.skills)).toContain("<name>code-simplifier</name>");
		expect(formatSkillsForPrompt(result.skills)).not.toContain("<name>代码精简</name>");
	});

	it("未配置时不从正文推断名称", () => {
		const result = load();
		expect(result.diagnostics).toEqual([]);
		expect(result.skills[0].displayName).toBeUndefined();
	});

	it.each(['" "', "true", "42", "[]", "null"])("无效显示名称 %s 产生警告但保留技能", (value) => {
		const result = load(`display-name: ${value}\n`);
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0].displayName).toBeUndefined();
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ message: "display-name must be a non-empty string" }),
		]);
	});

	it("仅显式调用的技能仍保留显示名称且不进入提示词", () => {
		const result = load("display-name: 代码精简\ndisable-model-invocation: true\n");
		expect(result.skills[0].displayName).toBe("代码精简");
		expect(formatSkillsForPrompt(result.skills)).toBe("");
	});

	it.each(["$代码", "$精简", "$code", "$simplifier"])("候选支持 %s 搜索并插入英文标识", async (input) => {
		const provider = new CombinedAutocompleteProvider([], dir, undefined, [
			{
				value: "$code-simplifier",
				label: "代码精简 · code-simplifier",
				description: "精简代码",
			},
		]);
		const result = await provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
		expect(result?.items).toEqual([
			expect.objectContaining({ value: "$code-simplifier", label: "代码精简 · code-simplifier" }),
		]);
		const applied = provider.applyCompletion([input], 0, input.length, result!.items[0], result!.prefix);
		expect(applied.lines).toEqual(["$code-simplifier "]);
	});
});
