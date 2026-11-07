import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function setup(options: HarnessOptions = {}, abortHandler?: () => void) {
	let pi!: ExtensionAPI;
	let ctx!: ExtensionContext;
	const harness = await createHarness({
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
	harnesses.push(harness);
	await harness.session.bindExtensions({ abortHandler });
	return { harness, pi, ctx };
}

async function compactionFixture(abortHandler?: () => void, extra: HarnessOptions = {}) {
	let entered!: (event: SessionBeforeCompactEvent) => void;
	let release!: () => void;
	const ready = new Promise<SessionBeforeCompactEvent>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const state = await setup(
		{
			...extra,
			settings: { compaction: { enabled: true, reserveTokens: 16, keepRecentTokens: 1 }, ...extra.settings },
			extensionFactories: [
				...(extra.extensionFactories ?? []),
				(api) => {
					api.on("session_before_compact", async (event) => {
						entered(event);
						await gate;
						return {
							compaction: {
								summary: "测试压缩摘要",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		},
		abortHandler,
	);
	state.harness.setResponses([fauxAssistantMessage("已有回复")]);
	await state.harness.session.prompt("已有消息");
	return { ...state, ready, release };
}

describe("用户输入接收回执", () => {
	it("用户消息持久化后确认一次，而不是依赖整轮 Promise 返回", async () => {
		const { harness, pi } = await setup();
		harness.setResponses([fauxAssistantMessage("回复")]);
		const receipts: boolean[] = [];
		await pi.sendUserMessage("用户消息", {
			onInputResult: (accepted) => {
				receipts.push(accepted);
				expect(
					harness.sessionManager
						.getBranch()
						.some((entry) => entry.type === "message" && entry.message.role === "user"),
				).toBe(true);
				expect(harness.faux.state.callCount).toBe(0);
			},
		});
		expect(receipts).toEqual([true]);
	});

	it.each([false, true])("启动前取消返回未接收，模式自定义 abortHandler=%s", async (customAbort) => {
		let entered!: () => void;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const abortHandler = customAbort ? vi.fn() : undefined;
		const { harness, pi, ctx } = await setup(
			{
				extensionFactories: [
					(api) => {
						api.on("before_agent_start", async () => {
							entered();
							await gate;
						});
					},
				],
			},
			abortHandler,
		);
		const receipts: boolean[] = [];
		const operation = pi.sendUserMessage("取消的输入", { onInputResult: (accepted) => receipts.push(accepted) });
		try {
			await ready;
			ctx.abort();
			release();
			await operation;
			expect(receipts).toEqual([false]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "message")).toHaveLength(0);
			if (abortHandler) expect(abortHandler).toHaveBeenCalledOnce();
		} finally {
			release();
			await operation;
		}
	});

	it("扩展正式处理输入时确认成功，不要求产生模型消息", async () => {
		const { harness, pi } = await setup({
			extensionFactories: [
				(api) => {
					api.on("input", () => ({ action: "handled" }));
				},
			],
		});
		const receipts: boolean[] = [];
		await pi.sendUserMessage("扩展处理", { onInputResult: (accepted) => receipts.push(accepted) });
		expect(receipts).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it.each(["steer", "followUp"] as const)("忙碌时 %s 成功排队即确认，不等待模型完成", async (deliverAs) => {
		let entered!: () => void;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, pi } = await setup({
			extensionFactories: [
				(api) => {
					api.on("before_agent_start", async () => {
						entered();
						await gate;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("首轮回复"), fauxAssistantMessage("后续回复")]);
		const running = harness.session.prompt("主请求");
		try {
			await ready;
			const receipts: boolean[] = [];
			await pi.sendUserMessage("排队消息", { deliverAs, onInputResult: (accepted) => receipts.push(accepted) });
			expect(receipts).toEqual([true]);
			expect(harness.session.pendingMessageCount).toBe(1);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			release();
			await running;
		}
	});

	it("启动失败保留原错误并只回报一次未接收", async () => {
		const { pi } = await setup({ withConfiguredAuth: false });
		const receipts: boolean[] = [];
		await expect(
			pi.sendUserMessage("无认证输入", { onInputResult: (accepted) => receipts.push(accepted) }),
		).rejects.toThrow();
		expect(receipts).toEqual([false]);
	});

	it("接收后立即取消，不把已持久化的输入改报为未接收", async () => {
		const { harness, pi, ctx } = await setup();
		const receipts: boolean[] = [];
		await pi.sendUserMessage("已接收后取消", {
			onInputResult: (accepted) => {
				receipts.push(accepted);
				if (accepted) ctx.abort();
			},
		});
		expect(receipts).toEqual([true]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);
	});
});

describe("手动压缩与远程输入互斥", () => {
	it("首次等待前占用压缩状态，拒绝普通及排队输入，完成后恢复接收", async () => {
		const f = await compactionFixture();
		const operation = f.harness.session.compact();
		try {
			expect(f.ctx.isIdle()).toBe(false);
			await f.ready;
			await expect(f.harness.session.prompt("直接输入")).rejects.toThrow(/manual compaction/);
			for (const deliverAs of [undefined, "steer", "followUp"] as const) {
				const receipts: boolean[] = [];
				await expect(
					f.pi.sendUserMessage("远程输入", { deliverAs, onInputResult: (accepted) => receipts.push(accepted) }),
				).rejects.toThrow(/manual compaction/);
				expect(receipts).toEqual([false]);
			}
			expect(f.harness.faux.state.callCount).toBe(1);
			f.release();
			await operation;
			expect(f.ctx.isIdle()).toBe(true);
			f.harness.setResponses([fauxAssistantMessage("压缩后回复")]);
			const receipts: boolean[] = [];
			await f.pi.sendUserMessage("压缩后输入", { onInputResult: (accepted) => receipts.push(accepted) });
			expect(receipts).toEqual([true]);
			expect(
				f.harness.session.messages.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes("压缩后输入"),
				),
			).toBe(true);
		} finally {
			f.release();
			await operation.catch(() => {});
		}
	});

	it.each([false, true])("ctx.abort 取消压缩且不跳过核心取消，模式自定义 abortHandler=%s", async (customAbort) => {
		const abortHandler = customAbort ? vi.fn() : undefined;
		const f = await compactionFixture(abortHandler);
		const operation = new Promise<unknown>((resolve, reject) => {
			f.ctx.compact({ onComplete: resolve, onError: reject });
		});
		try {
			const event = await f.ready;
			f.ctx.abort();
			expect(event.signal.aborted).toBe(true);
			const rejected = expect(operation).rejects.toThrow("Compaction cancelled");
			f.release();
			await rejected;
			expect(f.ctx.isIdle()).toBe(true);
			if (abortHandler) expect(abortHandler).toHaveBeenCalledOnce();
		} finally {
			f.release();
			await operation.catch(() => {});
		}
	});

	it("首次等待期间即可取消压缩，取消后仍保留正常持久化订阅", async () => {
		const f = await compactionFixture();
		const operation = f.harness.session.compact();
		f.ctx.abort();
		await expect(operation).rejects.toThrow("Compaction cancelled");
		expect(f.ctx.isIdle()).toBe(true);
		expect(f.harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });
		f.harness.setResponses([fauxAssistantMessage("取消后的回复")]);
		const receipts: boolean[] = [];
		await f.pi.sendUserMessage("取消后的输入", { onInputResult: (accepted) => receipts.push(accepted) });
		expect(receipts).toEqual([true]);
		expect(
			f.harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(2);
	});

	it("重复压缩被拒绝，不取消或覆盖第一轮压缩", async () => {
		const f = await compactionFixture();
		const operation = f.harness.session.compact();
		try {
			const event = await f.ready;
			await expect(f.harness.session.compact()).rejects.toThrow(/already running/);
			expect(event.signal.aborted).toBe(false);
			f.release();
			expect((await operation).summary).toBe("测试压缩摘要");
			expect(f.ctx.isIdle()).toBe(true);
		} finally {
			f.release();
			await operation.catch(() => {});
		}
	});

	it("异步 input 钩子返回时重新检查手动压缩，不能穿透互斥", async () => {
		let inputStarted!: () => void;
		let releaseInput!: () => void;
		const ready = new Promise<void>((resolve) => {
			inputStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let block = false;
		const f = await compactionFixture(undefined, {
			extensionFactories: [
				(api) => {
					api.on("input", async () => {
						if (block) {
							inputStarted();
							await gate;
						}
						return { action: "continue" };
					});
				},
			],
		});
		block = true;
		const receipts: boolean[] = [];
		const input = f.pi.sendUserMessage("延迟输入", { onInputResult: (accepted) => receipts.push(accepted) });
		await ready;
		const operation = f.harness.session.compact();
		try {
			await f.ready;
			const rejected = expect(input).rejects.toThrow(/manual compaction/);
			releaseInput();
			await rejected;
			expect(receipts).toEqual([false]);
			expect(f.harness.faux.state.callCount).toBe(1);
		} finally {
			releaseInput();
			f.release();
			await input.catch(() => {});
			await operation.catch(() => {});
		}
	});
});
