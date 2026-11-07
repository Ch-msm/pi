import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRequestEndEvent } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

describe("完整请求结束事件", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: HarnessOptions = {}) {
		const ends: AgentRequestEndEvent[] = [];
		const harness = await createHarness({
			...options,
			extensionFactories: [
				...(options.extensionFactories ?? []),
				(pi) => {
					pi.on("agent_request_end", (event) => {
						ends.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		return { harness, ends };
	}

	it("多次自动重试成功后只触发一次，保留最终回复", async () => {
		const { harness, ends } = await setup({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }),
			fauxAssistantMessage("最终回复"),
		]);
		await harness.session.prompt("测试");
		expect(harness.eventsOfType("agent_end")).toHaveLength(3);
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(false);
		expect(ends[0].messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "最终回复" }],
		});
	});

	it("重试耗尽后只触发一次失败", async () => {
		const { harness, ends } = await setup({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);
		await harness.session.prompt("测试");
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(false);
		expect(ends[0].messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "overloaded_error" });
	});

	it("取消重试等待被明确标记为中断，而不是最终模型失败", async () => {
		const { harness, ends } = await setup({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10_000 } },
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const started = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});
		const running = harness.session.prompt("测试");
		await started;
		expect(ends).toHaveLength(0);
		harness.session.abortRetry();
		await running;
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("等待压缩续跑完成后才触发最终事件", async () => {
		const { harness, ends } = await setup();
		const internals = harness.session as unknown as {
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(internals, "_runAutoCompaction")
			.mockImplementationOnce(async () => {
				entered();
				await pending;
				return true;
			})
			.mockResolvedValue(false);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
			fauxAssistantMessage("压缩后恢复完成"),
		]);
		const running = harness.session.prompt("测试");
		try {
			await started;
			expect(ends).toHaveLength(0);
		} finally {
			release();
		}
		await running;
		expect(ends).toHaveLength(1);
		expect(ends[0].messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "压缩后恢复完成" }] });
	});

	it("工具执行阶段中断也标记取消，即使先前助手消息为 toolUse", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "等待",
			description: "等待取消",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				entered();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			},
		};
		const { harness, ends } = await setup({ tools: [tool] });
		harness.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
		const running = harness.session.prompt("测试");
		await started;
		await harness.session.abort();
		await running;
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
	});

	it.each(["compaction", "request"] as const)("通过 %s 取消真正的自动压缩会标记请求中断", async (mode) => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const { harness, ends } = await setup({
			settings: { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 16, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						entered();
						await new Promise<void>((resolve) => {
							if (event.signal.aborted) resolve();
							else event.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						return { cancel: true };
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("早期回复一"), fauxAssistantMessage("早期回复二")]);
		await harness.session.prompt("早期消息一");
		await harness.session.prompt("早期消息二");
		ends.length = 0;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
		]);
		const running = harness.session.prompt("继续");
		await started;
		expect(ends).toHaveLength(0);
		if (mode === "compaction") harness.session.abortCompaction();
		else await harness.session.abort();
		await running;
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
	});

	it("会话销毁后不再向失效扩展发送结束事件", async () => {
		const { harness, ends } = await setup({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10_000 } },
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const started = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});
		const running = harness.session.prompt("测试");
		await started;
		harness.session.dispose();
		await running;
		expect(ends).toHaveLength(0);
	});

	it("请求异常仍触发一次最终事件并保留原异常", async () => {
		const { harness, ends } = await setup();
		vi.spyOn(harness.session.agent, "prompt").mockRejectedValueOnce(new Error("执行异常"));
		await expect(harness.session.prompt("测试")).rejects.toThrow("执行异常");
		expect(ends).toEqual([{ type: "agent_request_end", messages: [], aborted: false, errorMessage: "执行异常" }]);
	});

	it.each(["user", "custom"] as const)("重试等待期间的 %s 后台消息排队，取消原请求后不再启动模型", async (kind) => {
		const { harness, ends } = await setup({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const started = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});
		const running = harness.session.prompt("原始用户请求");
		await started;
		try {
			if (kind === "user") await harness.session.sendUserMessage("后台结果", { deliverAs: "followUp" });
			else
				await harness.session.sendCustomMessage(
					{ customType: "background", content: "后台结果", display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			expect(ends).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(harness.session.extensionRunner.createContext().isIdle()).toBe(false);
			harness.session.abortRetry();
			await running;
			expect(ends).toHaveLength(1);
			expect(ends[0].aborted).toBe(true);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		} finally {
			harness.session.abortRetry();
			await running;
		}
	});

	it.each(["user", "custom"] as const)("重试恢复后处理排队的 %s 消息，整次请求只结束一次", async (kind) => {
		const { harness, ends } = await setup({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("恢复完成"),
			fauxAssistantMessage("后台结果处理完成"),
		]);
		const started = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});
		const running = harness.session.prompt("原始请求");
		await started;
		try {
			if (kind === "user") await harness.session.sendUserMessage("后台结果", { deliverAs: "followUp" });
			else
				await harness.session.sendCustomMessage(
					{ customType: "background", content: "后台结果", display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			expect(ends).toHaveLength(0);
			await running;
			expect(ends).toHaveLength(1);
			expect(ends[0].aborted).toBe(false);
			expect(ends[0].messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "后台结果处理完成" }],
			});
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			harness.session.abortRetry();
			await running.catch(() => {});
		}
	});

	it("重试等待时未指定入队方式的新请求被拒绝，不覆盖原请求", async () => {
		const { harness, ends } = await setup({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const started = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});
		const running = harness.session.prompt("原始请求");
		await started;
		try {
			await expect(harness.session.prompt("冲突的新请求")).rejects.toThrow("already processing");
			expect(ends).toHaveLength(0);
		} finally {
			harness.session.abortRetry();
			await running;
		}
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
	});

	it("第二次失败的消息处理阶段中断会清理重试状态，并明确结束重试", async () => {
		let entered!: () => void;
		let release!: () => void;
		let errors = 0;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, ends } = await setup({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant" && event.message.stopReason === "error" && ++errors === 2) {
							entered();
							await gate;
						}
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);
		const running = harness.session.prompt("测试请求");
		await started;
		const aborting = harness.session.abort();
		release();
		await aborting;
		await running;
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.isProcessing).toBe(false);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: 1, finalError: "Retry cancelled" },
		]);
	});

	it.each(["reject", "user", "custom"] as const)("启动准备期间已经占有请求，%s 消息不会重入", async (kind) => {
		let entered = 0;
		let ready!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, ends } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered++;
						ready();
						await gate;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("首个回复"), fauxAssistantMessage("最终回复")]);
		const first = harness.session.prompt("第一个请求");
		await started;
		try {
			expect(harness.session.isProcessing).toBe(true);
			if (kind === "reject") await expect(harness.session.prompt("冲突请求")).rejects.toThrow("already processing");
			else if (kind === "user") await harness.session.sendUserMessage("后台结果", { deliverAs: "followUp" });
			else
				await harness.session.sendCustomMessage(
					{ customType: "background", content: "后台结果", display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			expect(entered).toBe(1);
			expect(ends).toHaveLength(0);
		} finally {
			release();
			await first;
		}
		expect(harness.faux.state.callCount).toBe(kind === "reject" ? 1 : 2);
		expect(ends).toHaveLength(1);
		expect(ends[0].messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: kind === "reject" ? "首个回复" : "最终回复" }],
		});
	});

	it.each(["hook", "callback"] as const)("准备阶段由 %s 中断时不启动模型，也不丢失 nextTurn 消息", async (mode) => {
		let ready!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, ends } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						ready();
						await gate;
					});
				},
			],
		});
		await harness.session.sendCustomMessage(
			{ customType: "next", content: "保留的内容", display: true },
			{ deliverAs: "nextTurn" },
		);
		const first = harness.session.prompt("取消的请求", {
			preflightResult: (accepted) => {
				if (accepted && mode === "callback") void harness.session.abort();
			},
		});
		await started;
		if (mode === "hook") await harness.session.abort();
		release();
		await first;
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
		harness.setResponses([fauxAssistantMessage("后续回复")]);
		await harness.session.prompt("后续请求");
		expect(
			harness.session.agent.state.messages.some(
				(message) => message.role === "custom" && message.customType === "next",
			),
		).toBe(true);
		expect(ends).toHaveLength(2);
		expect(ends[1].aborted).toBe(false);
	});

	it("启动前的溢出恢复期间也排队后台消息，取消后不再启动模型", async () => {
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const { harness, ends } = await setup({
			settings: { compaction: { enabled: true, reserveTokens: 16, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						ready();
						await new Promise<void>((resolve) => {
							if (event.signal.aborted) resolve();
							else event.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						return { cancel: true };
					});
				},
			],
		});
		const model = harness.getModel();
		for (let i = 0; i < 2; i++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `历史消息 ${i}` }],
				timestamp: Date.now() - 20 + i * 2,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage(
					"历史回复",
					i === 1 ? { stopReason: "error", errorMessage: "maximum context length exceeded" } : {},
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now() - 19 + i * 2,
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const running = harness.session.prompt("新的用户请求");
		await started;
		await harness.session.sendUserMessage("后台结果", { deliverAs: "followUp" });
		expect(ends).toHaveLength(0);
		await harness.session.abort();
		await running;
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("准备阶段销毁会话后不再启动模型，也不接受新的执行请求", async () => {
		let ready!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness, ends } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						ready();
						await gate;
					});
				},
			],
		});
		const running = harness.session.prompt("准备中的请求");
		await started;
		harness.session.dispose();
		release();
		await running;
		expect(harness.faux.state.callCount).toBe(0);
		expect(ends).toHaveLength(0);
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "stale", content: "旧请求", display: true },
				{ triggerTurn: true },
			),
		).rejects.toThrow("session is disposed");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("启动前的模型鉴权错误也结束请求并释放占用", async () => {
		const { harness, ends } = await setup({ withConfiguredAuth: false });
		await expect(harness.session.prompt("测试")).rejects.toThrow("No API key");
		expect(ends).toHaveLength(1);
		expect(ends[0].errorMessage).toContain("No API key");
		expect(harness.session.isProcessing).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("自定义消息的 UI 预发送阶段也不能重入请求", async () => {
		const { harness, ends } = await setup();
		harness.setResponses([fauxAssistantMessage("首个回复"), fauxAssistantMessage("最终回复")]);
		let injected = false;
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "custom" && !injected) {
				injected = true;
				return harness.session.sendUserMessage("后台结果", { deliverAs: "followUp" });
			}
		});
		await harness.session.sendCustomMessage(
			{ customType: "start", content: "启动请求", display: true },
			{ triggerTurn: true },
		);
		expect(harness.faux.state.callCount).toBe(2);
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(false);
		expect(ends[0].messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "最终回复" }] });
	});

	it("结束交接的微任务中入队的消息也在释放请求前消费", async () => {
		const { harness, ends } = await setup();
		harness.setResponses([fauxAssistantMessage("首个回复"), fauxAssistantMessage("迟到结果的最终回复")]);
		const internals = harness.session as unknown as { _handlePostAgentRun: () => Promise<boolean> };
		const original = internals._handlePostAgentRun.bind(harness.session);
		let delivery: Promise<void> | undefined;
		vi.spyOn(internals, "_handlePostAgentRun")
			.mockImplementationOnce(async () => {
				const result = await original();
				queueMicrotask(() => {
					delivery = harness.session.sendUserMessage("迟到的后台结果", { deliverAs: "followUp" });
				});
				return result;
			})
			.mockImplementation(original);
		await harness.session.prompt("测试请求");
		await delivery;
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(ends).toHaveLength(1);
		expect(ends[0].messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "迟到结果的最终回复" }] });
	});

	it("后续请求有独立的消息和取消状态", async () => {
		const { harness, ends } = await setup();
		harness.setResponses([fauxAssistantMessage("第一条"), fauxAssistantMessage("第二条")]);
		await harness.session.prompt("第一条请求");
		await harness.session.prompt("第二条请求");
		expect(ends).toHaveLength(2);
		expect(ends[1].aborted).toBe(false);
		expect(ends[1].messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(ends[1].messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "第二条" }] });
	});
});
