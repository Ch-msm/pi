import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../src/types.ts";

const mocks = vi.hoisted(() => {
	const model = (npm: string) => ({
		name: "测试模型",
		tool_call: true,
		reasoning: true,
		provider: { npm },
		limit: { context: 10000, output: 1000 },
	});
	const sources: Record<string, unknown> = {
		"https://models.dev/api.json": {
			opencode: {
				models: {
					"grok-build-0.1": model("@ai-sdk/openai"),
					"kimi-k2.6": model("@ai-sdk/anthropic"),
					"qwen-test": model("@ai-sdk/alibaba"),
					"gemini-test": model("@ai-sdk/google"),
				},
			},
			"opencode-go": {
				models: {
					"kimi-k2.6": model("@ai-sdk/openai-compatible"),
					"minimax-m2.7": model("@ai-sdk/anthropic"),
					"qwen3.6-plus": model("@ai-sdk/google"),
				},
			},
		},
		"https://openrouter.ai/api/v1/models": { data: [] },
		"https://ai-gateway.vercel.sh/v1/models": { data: [] },
	};
	const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input);
		if (!Object.hasOwn(sources, url)) throw new Error(`测试禁止未声明的网络请求：${url}`);
		return new Response(JSON.stringify(sources[url]));
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetch: fetchMock, write: vi.fn() };
});

vi.mock("fs", () => ({ writeFileSync: mocks.write }));
import "../scripts/generate-models.ts";

let models: Record<string, Record<string, Model<Api>>>;

beforeAll(async () => {
	await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
	const source = mocks.write.mock.calls[0][1] as string;
	const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
	const context = { exports: { MODELS: {} as typeof models } };
	runInNewContext(compiled.outputText, context);
	models = context.exports.MODELS;
});

afterAll(() => vi.unstubAllGlobals());

describe("OpenCode 生成器的协议兼容字段", () => {
	it("Responses 模型不携带 Completions 的 reasoning_effort 开关", () => {
		const model = models.opencode["grok-build-0.1"];
		expect(model.api).toBe("openai-responses");
		expect(model.compat).toBeUndefined();
		expect(model.thinkingLevelMap).toMatchObject({ off: null, minimal: null, low: null, medium: null });
	});

	it("Anthropic Kimi 不携带 Completions 的思考格式", () => {
		const model = models.opencode["kimi-k2.6"];
		expect(model.api).toBe("anthropic-messages");
		expect(model.compat).toBeUndefined();
	});

	it("Completions Kimi 保留原有思考兼容参数", () => {
		const model = models["opencode-go"]["kimi-k2.6"];
		expect(model.api).toBe("openai-completions");
		expect(model.compat).toEqual({ thinkingFormat: "deepseek", supportsReasoningEffort: false });
	});

	it("Alibaba Completions 保留缓存配置，Google 不混入兼容字段", () => {
		expect(models.opencode["qwen-test"].compat).toEqual({ cacheControlFormat: "anthropic" });
		expect(models.opencode["gemini-test"].api).toBe("google-generative-ai");
		expect(models.opencode["gemini-test"].compat).toBeUndefined();
	});

	it("OpenCode Go 的协议纠正和 Qwen 思考配置仍然生效", () => {
		expect(models["opencode-go"]["minimax-m2.7"].api).toBe("openai-completions");
		const qwen = models["opencode-go"]["qwen3.6-plus"];
		expect(qwen.api).toBe("openai-completions");
		expect(qwen.compat).toEqual({ thinkingFormat: "qwen" });
	});

	it("只读取本地模拟的三个模型目录，不写入真实生成文件", () => {
		expect(mocks.fetch.mock.calls.map(([input]) => String(input))).toEqual([
			"https://models.dev/api.json",
			"https://openrouter.ai/api/v1/models",
			"https://ai-gateway.vercel.sh/v1/models",
		]);
		expect(mocks.write.mock.calls[0][0]).toMatch(/src\/models\.generated\.ts$/);
	});
});
