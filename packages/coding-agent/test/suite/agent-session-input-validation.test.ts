import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SendUserMessageOptions } from "../../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function setup(options: HarnessOptions = {}) {
	let pi!: ExtensionAPI;
	let ctx!: ExtensionContext;
	const h = await createHarness({
		...options,
		extensionFactories: [
			...(options.extensionFactories ?? []),
			(api) => {
				pi = api;
				api.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	return { h, pi, ctx };
}

describe("输入最终预处理验证", () => {
	it("验证转换后的文字和图片，失败只回报一次未接收，不落盘或调用模型", async () => {
		const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
		const { h, pi } = await setup({
			extensionFactories: [
				(api) => {
					api.on("input", () => ({ action: "transform", text: "转换后的输入", images }));
				},
			],
		});
		const receipts: boolean[] = [];
		const failure = new Error("最终内容超限");
		const validate = vi.fn((content: unknown): undefined => {
			expect(content).toEqual([{ type: "text", text: "转换后的输入" }, ...images]);
			throw failure;
		});
		await expect(
			pi.sendUserMessage("原输入", { validateInput: validate, onInputResult: (value) => receipts.push(value) }),
		).rejects.toBe(failure);
		expect(validate).toHaveBeenCalledOnce();
		expect(receipts).toEqual([false]);
		expect(h.sessionManager.getBranch()).toEqual([]);
		expect(h.faux.state.callCount).toBe(0);
	});

	it.each([false, null, "async-success", "async-error"])(
		"错误的 JavaScript 验证器返回值不视为验证成功：%s",
		async (mode) => {
			const { h, pi } = await setup();
			const receipts: boolean[] = [];
			const validate = (() => {
				if (mode === "async-success") return Promise.resolve();
				if (mode === "async-error") return Promise.reject(new Error("异步验证失败"));
				return mode;
			}) as unknown as NonNullable<SendUserMessageOptions["validateInput"]>;
			await expect(
				pi.sendUserMessage("输入", { validateInput: validate, onInputResult: (value) => receipts.push(value) }),
			).rejects.toThrow("must be synchronous and return undefined");
			expect(receipts).toEqual([false]);
			expect(h.sessionManager.getBranch()).toEqual([]);
			expect(h.faux.state.callCount).toBe(0);
		},
	);

	it("直接 prompt 验证的是模板展开后的内容", async () => {
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({
				prompts: [
					{
						name: "expand",
						description: "测试模板",
						content: "展开后的 $1",
						filePath: "/virtual/expand.md",
						sourceInfo: createSyntheticSourceInfo("/virtual/expand.md", {
							source: "local",
							scope: "temporary",
							origin: "top-level",
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const { h } = await setup({ resourceLoader });
		await expect(
			h.session.prompt("/expand 正文", {
				validateInput: (content) => {
					expect(content).toEqual([{ type: "text", text: "展开后的 正文" }]);
					throw new Error("模板超限");
				},
			}),
		).rejects.toThrow("模板超限");
		expect(h.sessionManager.getBranch()).toEqual([]);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("验证通过后仍按持久化回执接收，不改变请求完成时机", async () => {
		const { h, pi } = await setup();
		h.setResponses([fauxAssistantMessage("回复")]);
		const validate = vi.fn((): undefined => {});
		const receipts: boolean[] = [];
		await pi.sendUserMessage("输入", { validateInput: validate, onInputResult: (value) => receipts.push(value) });
		expect(validate).toHaveBeenCalledTimes(2);
		expect(receipts).toEqual([true]);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("before_agent_start 改变图片后，提交前验证仍可拒绝且不落盘", async () => {
		const { h, pi } = await setup({
			extensionFactories: [
				(api) => {
					api.on("before_agent_start", (event) => {
						if (event.images?.[0]) event.images[0].data = "expanded";
					});
				},
			],
		});
		const receipts: boolean[] = [];
		const validate = vi.fn((content: unknown): undefined => {
			if (JSON.stringify(content).includes("expanded")) throw new Error("提交内容超限");
		});
		await expect(
			pi.sendUserMessage([{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }], {
				validateInput: validate,
				onInputResult: (value) => receipts.push(value),
			}),
		).rejects.toThrow("提交内容超限");
		expect(validate).toHaveBeenCalledTimes(2);
		expect(receipts).toEqual([false]);
		expect(h.sessionManager.getBranch()).toEqual([]);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("已被扩展处理的输入不调用用户消息验证器", async () => {
		const { h, pi } = await setup({
			extensionFactories: [
				(api) => {
					api.on("input", () => ({ action: "handled" }));
				},
			],
		});
		const validate = vi.fn((): undefined => {
			throw new Error("不应调用");
		});
		const receipts: boolean[] = [];
		await pi.sendUserMessage("输入", { validateInput: validate, onInputResult: (value) => receipts.push(value) });
		expect(validate).not.toHaveBeenCalled();
		expect(receipts).toEqual([true]);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("验证期间取消后不继续接收输入", async () => {
		const { h, pi, ctx } = await setup();
		const receipts: boolean[] = [];
		await pi.sendUserMessage("输入", {
			validateInput: () => {
				ctx.abort();
			},
			onInputResult: (value) => receipts.push(value),
		});
		expect(receipts).toEqual([false]);
		expect(h.sessionManager.getBranch()).toEqual([]);
		expect(h.faux.state.callCount).toBe(0);
	});

	it.each([
		{ deliverAs: "steer" as const, command: false },
		{ deliverAs: "followUp" as const, command: false },
		{ deliverAs: "steer" as const, command: true },
		{ deliverAs: "followUp" as const, command: true },
	])("排队前验证失败不修改队列：$deliverAs，扩展命令=$command", async ({ deliverAs, command }) => {
		let entered!: () => void;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler = vi.fn();
		const { h, pi } = await setup({
			extensionFactories: [
				(api) => {
					api.registerCommand("validation-command", { handler });
					api.on("before_agent_start", async () => {
						entered();
						await gate;
					});
				},
			],
		});
		h.setResponses([fauxAssistantMessage("首轮回复")]);
		const first = h.session.prompt("进行中的输入");
		const receipts: boolean[] = [];
		try {
			await ready;
			await expect(
				pi.sendUserMessage(command ? "/validation-command" : "排队输入", {
					deliverAs,
					validateInput: () => {
						throw new Error("排队验证失败");
					},
					onInputResult: (value) => receipts.push(value),
				}),
			).rejects.toThrow("排队验证失败");
			expect(receipts).toEqual([false]);
			expect(h.session.pendingMessageCount).toBe(0);
			expect(handler).not.toHaveBeenCalled();
		} finally {
			release();
			await first;
		}
		expect(h.faux.state.callCount).toBe(1);
	});
});
