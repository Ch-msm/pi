import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type PrunePendingToolCallsToMessage = (
	this: {
		pendingTools: Map<string, ToolExecutionComponent>;
		chatContainer: Container;
	},
	message: AssistantMessage,
) => void;

function createToolCall(index: number): ToolCall {
	return {
		type: "toolCall",
		id: `tool-${index}`,
		name: "echo",
		arguments: { value: index },
	};
}

function createAssistantMessage(toolCalls: ToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("InteractiveMode tool-call-limit pending rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("removes streaming tool components absent from the finalized assistant message", () => {
		const chatContainer = new Container();
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ui = { requestRender() {} } as unknown as TUI;
		const streamedToolCalls = Array.from({ length: 8 }, (_, index) => createToolCall(index + 1));

		for (const toolCall of streamedToolCalls) {
			const component = new ToolExecutionComponent(
				toolCall.name,
				toolCall.id,
				toolCall.arguments,
				{ showImages: false },
				undefined,
				ui,
				process.cwd(),
			);
			pendingTools.set(toolCall.id, component);
			chatContainer.addChild(component);
		}

		const prunePendingToolCallsToMessage = (
			InteractiveMode.prototype as unknown as {
				prunePendingToolCallsToMessage: PrunePendingToolCallsToMessage;
			}
		).prunePendingToolCallsToMessage;
		prunePendingToolCallsToMessage.call(
			{ pendingTools, chatContainer },
			createAssistantMessage(streamedToolCalls.slice(0, 4)),
		);

		expect([...pendingTools.keys()]).toEqual(["tool-1", "tool-2", "tool-3", "tool-4"]);
		expect(chatContainer.children).toEqual([...pendingTools.values()]);
	});
});
