import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "../src/providers/openai-responses.ts";

afterEach(() => vi.restoreAllMocks());

async function request(responseTier: string | undefined, options: OpenAIResponsesOptions = {}) {
	let sentPayload: Record<string, unknown> = {};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		sentPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const events = [
			{ type: "response.created", response: { id: "resp_test", service_tier: "priority" } },
			{
				type: "response.completed",
				response: {
					id: "resp_test",
					status: "completed",
					service_tier: responseTier,
					usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
				},
			},
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	const stream = streamOpenAIResponses(
		getModel("openai", "gpt-5.4"),
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ apiKey: "test-key", ...options },
	);
	const message = await stream.result();
	expect(message.stopReason).toBe("stop");
	return { message, sentPayload };
}

describe("Responses 请求与响应档位证据", () => {
	it.each(["priority", "fast"])("保留扩展注入的 %s 及最终响应档位", async (tier) => {
		const { message, sentPayload } = await request(tier, {
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), service_tier: tier }),
		});
		expect(sentPayload.service_tier).toBe(tier);
		expect(message.requestedServiceTier).toBe(tier);
		expect(message.responseServiceTier).toBe(tier);
		expect(JSON.parse(JSON.stringify(message))).toMatchObject({
			requestedServiceTier: tier,
			responseServiceTier: tier,
		});
	});

	it("请求 priority、最终返回 default 时分别保留，不采用 created 的 priority", async () => {
		const { message } = await request("default", { serviceTier: "priority" });
		expect(message.requestedServiceTier).toBe("priority");
		expect(message.responseServiceTier).toBe("default");
	});

	it("缺少最终响应档位时不采用请求档位或 created 档位补全", async () => {
		const { message } = await request(undefined, { serviceTier: "priority" });
		expect(message.requestedServiceTier).toBe("priority");
		expect(message.responseServiceTier).toBeUndefined();
	});

	it("未指定请求档位时不根据响应反推", async () => {
		const { message, sentPayload } = await request("priority");
		expect(sentPayload.service_tier).toBeUndefined();
		expect(message.requestedServiceTier).toBeUndefined();
		expect(message.responseServiceTier).toBe("priority");
	});

	it("采集 onPayload 改写后的请求而不是原始选项", async () => {
		const { message, sentPayload } = await request("default", {
			serviceTier: "priority",
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), service_tier: "default" }),
		});
		expect(sentPayload.service_tier).toBe("default");
		expect(message.requestedServiceTier).toBe("default");
	});

	it("onPayload 移除档位时不保留旧选项", async () => {
		const { message } = await request("priority", {
			serviceTier: "priority",
			onPayload: (payload) => {
				delete (payload as Record<string, unknown>).service_tier;
			},
		});
		expect(message.requestedServiceTier).toBeUndefined();
	});
});
