import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

describe("issue #2023 queued slash-command follow-up", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("dispatches extension-origin queued slash-command follow-ups as extension commands", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const commandRuns: string[] = [];
		const internalCommandRuns: string[] = [];
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test to release execution",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
					pi.registerCommand("internal-cmd", {
						internal: true,
						description: "Internal command",
						handler: async (args) => {
							internalCommandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first turn complete"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("/testcmd queued", { deliverAs: "followUp" });
		extensionApi?.sendUserMessage("/internal-cmd queued-internal", { deliverAs: "followUp" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		releaseToolExecution?.();
		await promptPromise;
		await harness.session.agent.waitForIdle();

		expect(commandRuns).toEqual(["queued"]);
		expect(internalCommandRuns).toEqual(["queued-internal"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(getAssistantTexts(harness)).not.toContain("queued follow-up handled by model");
	});

	it("queues registered commands before extension input handlers can consume them", async () => {
		let sent = false;
		let sawCommandInput = false;
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						await pi.sendUserMessage("/testcmd queued-after-input", { deliverAs: "followUp" });
					});
				},
				(pi) => {
					pi.on("input", async (event) => {
						if (event.source === "extension" && event.text.startsWith("/testcmd")) {
							sawCommandInput = true;
							await new Promise((resolve) => setTimeout(resolve, 20));
							return { action: "handled" };
						}
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first turn complete"), fauxAssistantMessage("command leaked")]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		expect(commandRuns).toEqual(["queued-after-input"]);
		expect(sawCommandInput).toBe(false);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(getAssistantTexts(harness)).not.toContain("command leaked");
	});

	it("resolves sendUserMessage after asynchronous input processing has queued a normal follow-up", async () => {
		let sent = false;
		let inputFinished = false;
		let resolvedAfterInput = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						await pi.sendUserMessage("delayed follow-up", { deliverAs: "followUp" });
						resolvedAfterInput = inputFinished;
					});
				},
				(pi) => {
					pi.on("input", async (event) => {
						if (event.source !== "extension") return;
						await new Promise((resolve) => setTimeout(resolve, 20));
						inputFinished = true;
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("first turn complete"), fauxAssistantMessage("follow-up complete")]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		expect(resolvedAfterInput).toBe(true);
		expect(getUserTexts(harness)).toEqual(["start", "delayed follow-up"]);
		expect(getAssistantTexts(harness)).toContain("follow-up complete");
	});
});
