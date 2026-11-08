import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	scripts: Record<string, string>;
};

describe("模型目录更新与普通构建分离", () => {
	it("普通构建只编译本地源码，不执行目录生成命令", () => {
		expect(scripts.build).toBe("tsgo -p tsconfig.build.json");
		expect(scripts.prebuild).toBeUndefined();
		expect(scripts.postbuild).toBeUndefined();
	});

	it("保留文本和图像模型目录的显式更新命令", () => {
		expect(scripts["generate-models"]).toBe("node scripts/generate-models.ts");
		expect(scripts["generate-image-models"]).toBe("node scripts/generate-image-models.ts");
	});
});
