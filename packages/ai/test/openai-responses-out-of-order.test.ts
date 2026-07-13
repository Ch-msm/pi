import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Construct a stream where reasoning(0), text(1), and toolCall(2) items
 * interleave: the done events arrive in reverse order (2→1→0), not the
 * order they were added. This is the out-of-order scenario that the slot
 * mechanism is designed to handle — the old currentItem/currentBlock
 * approach would lose reasoning content or corrupt content indices.
 */
async function* createInterleavedEvents(): AsyncIterable<ResponseStreamEvent> {
	// added: reasoning(0), text(1), toolCall(2) — in index order
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "reasoning", id: "rs_0", summary: [], content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 1,
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 2,
		item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "edit", arguments: "" },
	} as unknown as ResponseStreamEvent;

	// deltas arrive for all three in any order
	yield {
		type: "response.reasoning_text.delta",
		output_index: 0,
		delta: "Thinking about the task",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		output_index: 1,
		delta: "Here is my response",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		output_index: 2,
		delta: '{"path":"a.txt"}',
	} as unknown as ResponseStreamEvent;

	// done events arrive in REVERSE order: toolCall(2), text(1), reasoning(0)
	yield {
		type: "response.output_item.done",
		output_index: 2,
		item: {
			type: "function_call",
			id: "fc_2",
			call_id: "call_2",
			name: "edit",
			arguments: '{"path":"a.txt"}',
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 1,
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Here is my response", annotations: [] }],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		item: { type: "reasoning", id: "rs_0", summary: [], content: [] },
	} as unknown as ResponseStreamEvent;

	yield {
		type: "response.completed",
		response: {
			id: "resp_test",
			status: "completed",
			output: [],
		},
	} as unknown as ResponseStreamEvent;
}

/**
 * Stream that ends without any terminal event (response.completed/incomplete/failed).
 * The new sawTerminalResponseEvent guard should throw.
 */
async function* createStreamWithoutTerminalEvent(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		output_index: 0,
		delta: "Partial response before stream breaks",
	} as unknown as ResponseStreamEvent;
	// No terminal event — stream just ends
}

/**
 * Two reasoning items with interleaved text. Verifies that multiple reasoning
 * slots don't collide and each preserves its own thinking content.
 */
async function* createMultipleReasoningInterleavedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "reasoning", id: "rs_0", summary: [], content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 1,
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 2,
		item: { type: "reasoning", id: "rs_2", summary: [], content: [] },
	} as unknown as ResponseStreamEvent;

	// Deltas interleave between the two reasoning slots
	yield {
		type: "response.reasoning_text.delta",
		output_index: 0,
		delta: "First reasoning",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		output_index: 2,
		delta: "Second reasoning",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		output_index: 1,
		delta: "Final answer",
	} as unknown as ResponseStreamEvent;

	// Done in reverse: reasoning(2), text(1), reasoning(0)
	// Done items carry non-empty summaries — exercises the main path
	// where thinking is overwritten from item.summary at output_item.done
	yield {
		type: "response.output_item.done",
		output_index: 2,
		item: {
			type: "reasoning",
			id: "rs_2",
			summary: [{ type: "summary_text", text: "Final second reasoning" }],
			content: [],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 1,
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Final answer", annotations: [] }],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "reasoning",
			id: "rs_0",
			summary: [{ type: "summary_text", text: "Final first reasoning" }],
			content: [],
		},
	} as unknown as ResponseStreamEvent;

	yield {
		type: "response.completed",
		response: {
			id: "resp_test",
			status: "completed",
			output: [],
		},
	} as unknown as ResponseStreamEvent;
}

describe("openai responses out-of-order reasoning slots", () => {
	it("preserves reasoning, text, and toolCall content when done events arrive in reverse order", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(createInterleavedEvents(), output, stream, model);

		// Content should be in added order: reasoning(0), text(1), toolCall(2)
		expect(output.content).toHaveLength(3);

		// Slot 0: reasoning
		expect(output.content[0]?.type).toBe("thinking");
		if (output.content[0]?.type === "thinking") {
			expect(output.content[0].thinking).toBe("Thinking about the task");
		}

		// Slot 1: text
		expect(output.content[1]?.type).toBe("text");
		if (output.content[1]?.type === "text") {
			expect(output.content[1].text).toBe("Here is my response");
		}

		// Slot 2: toolCall
		expect(output.content[2]?.type).toBe("toolCall");
		if (output.content[2]?.type === "toolCall") {
			expect(output.content[2].name).toBe("edit");
			expect(output.content[2].arguments).toEqual({ path: "a.txt" });
		}

		// Each slot should have matching start/end events
		const events = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		expect(events.some((e) => e.type === "thinking_start")).toBe(true);
		expect(events.some((e) => e.type === "thinking_end")).toBe(true);
		expect(events.some((e) => e.type === "text_start")).toBe(true);
		expect(events.some((e) => e.type === "text_end")).toBe(true);
		expect(events.some((e) => e.type === "toolcall_start")).toBe(true);
		expect(events.some((e) => e.type === "toolcall_end")).toBe(true);
	});

	it("keeps multiple reasoning slots separate when their deltas interleave", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createMultipleReasoningInterleavedEvents(), output, stream, model);

		// Content: reasoning(0), text(1), reasoning(2)
		expect(output.content).toHaveLength(3);
		expect(output.content[0]?.type).toBe("thinking");
		expect(output.content[1]?.type).toBe("text");
		expect(output.content[2]?.type).toBe("thinking");

		if (output.content[0]?.type === "thinking" && output.content[2]?.type === "thinking") {
			// Each reasoning slot must have its own content, not mixed.
			// Done items carried non-empty summaries, so thinking should be
			// overwritten with the summary text (not the streamed delta).
			expect(output.content[0].thinking).toBe("Final first reasoning");
			expect(output.content[2].thinking).toBe("Final second reasoning");

			// thinkingSignature is per-slot (JSON.stringify of the done item).
			// Verify no cross-contamination between the two reasoning slots.
			expect(output.content[0].thinkingSignature).toBeDefined();
			expect(output.content[2].thinkingSignature).toBeDefined();
			expect(output.content[0].thinkingSignature).toContain("rs_0");
			expect(output.content[2].thinkingSignature).toContain("rs_2");
			expect(output.content[0].thinkingSignature).not.toBe(output.content[2].thinkingSignature);
		}

		if (output.content[1]?.type === "text") {
			expect(output.content[1].text).toBe("Final answer");
		}
	});

	it("throws when stream ends without a terminal response event", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createStreamWithoutTerminalEvent(), output, stream, model)).rejects.toThrow(
			"OpenAI Responses stream ended before a terminal response event",
		);
	});
});
