import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

describe("edit 提示词分层", () => {
	test("参数描述保留唯一匹配、原始文件和非重叠约束", () => {
		const tool = createEditToolDefinition(process.cwd());
		const replacements = tool.parameters.properties.edits;
		const oldText = replacements.items.properties.oldText;

		expect(oldText).toHaveProperty("description", expect.stringContaining("match once in the original file"));
		expect(oldText).toHaveProperty("description", expect.stringContaining("minimal but unique"));
		expect(oldText).toHaveProperty("description", expect.stringContaining("must not overlap another edit"));
		expect(replacements).toHaveProperty("description", expect.stringContaining("original file, not sequentially"));
		expect(replacements).toHaveProperty(
			"description",
			expect.stringContaining("Merge changes to the same block or nearby lines"),
		);
		expect(tool.description).toContain("Do not pad replacements with large unchanged regions");
	});

	test("常驻指南只保留工具选择与同文件批量编辑，不重复字段契约", () => {
		const tool = createEditToolDefinition(process.cwd());
		const prompt = buildSystemPrompt({
			cwd: process.cwd(),
			selectedTools: [tool.name],
			toolSnippets: { [tool.name]: tool.promptSnippet! },
			promptGuidelines: tool.promptGuidelines,
		});

		expect(tool.promptGuidelines).toHaveLength(1);
		expect(prompt).toContain(
			"Use edit for targeted changes; batch independent replacements to the same file in one call.",
		);
		expect(prompt).not.toContain("oldText");
		expect(prompt).not.toContain("not sequentially");
	});
});
