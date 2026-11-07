import { type AutocompleteProvider, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { parseCompactCommandArguments } from "../src/modes/interactive/compact-command.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

async function createContext(options: { configured?: boolean; withMessages?: boolean } = {}) {
	const harness = await createHarness({
		models: [
			{ id: "picker-chat", name: "Picker chat" },
			{ id: "picker-default", name: "Picker default" },
			{ id: "picker-temporary", name: "Picker temporary" },
		],
	});
	harnesses.push(harness);
	const chat = harness.getModel();
	const configured = harness.getModel("picker-default")!;
	harness.settingsManager.applyOverrides({
		defaultProvider: chat.provider,
		defaultModel: chat.id,
		compaction: { model: options.configured === false ? undefined : `${configured.provider}/${configured.id}` },
	});
	if (options.withMessages !== false) {
		for (const text of ["第一条消息", "第二条消息"]) {
			harness.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		}
	}

	const compact = vi.spyOn(harness.session, "compact").mockResolvedValue({
		summary: "本地模拟摘要",
		firstKeptEntryId: "kept-entry",
		tokensBefore: 100,
	});
	const setModel = vi.spyOn(harness.session, "setModel");
	const saveDefault = vi.spyOn(harness.settingsManager, "setDefaultModelAndProvider");
	const saveCompaction = vi.spyOn(harness.settingsManager, "setCompactionModel");
	const fakeThis = {
		session: harness.session,
		sessionManager: harness.sessionManager,
		settingsManager: harness.settingsManager,
		loadingAnimation: undefined as { stop: () => void } | undefined,
		statusContainer: { clear: vi.fn() },
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		showSelector: vi.fn(),
		defaultEditor: { setSkillNames: vi.fn() },
		prefixAutocompleteDescription: (description?: string) => description ?? "",
		fdPath: undefined,
	};
	const handle = Reflect.get(InteractiveMode.prototype, "handleCompactCommand") as (
		this: typeof fakeThis,
		argumentsText?: string,
	) => Promise<void>;
	const createProvider = Reflect.get(InteractiveMode.prototype, "createBaseAutocompleteProvider") as (
		this: typeof fakeThis,
	) => AutocompleteProvider;

	return {
		harness,
		fakeThis,
		compact,
		setModel,
		saveDefault,
		saveCompaction,
		start: (argumentsText?: string) => handle.call(fakeThis, argumentsText),
		createProvider: () => createProvider.call(fakeThis),
	};
}

describe("/compact 命令参数", () => {
	test.each([
		[undefined, undefined, undefined],
		["", undefined, undefined],
		["保留关键结论", undefined, "保留关键结论"],
		["  保留两行\n  原始格式  ", undefined, "保留两行\n  原始格式"],
		["--model DeepSeek/deepseek-flash", "DeepSeek/deepseek-flash", undefined],
		["--model=DeepSeek/deepseek-flash 保留结论", "DeepSeek/deepseek-flash", "保留结论"],
		['--model "p/model with spaces" 保留结论', "p/model with spaces", "保留结论"],
		["--model\tDeepSeek/deepseek-flash\n保留两行\n  原文", "DeepSeek/deepseek-flash", "保留两行\n  原文"],
		["-- --model 是补充要求", undefined, "--model 是补充要求"],
		["--model p/id -- --model 是补充要求", "p/id", "--model 是补充要求"],
		["保留 --model 示例", undefined, "保留 --model 示例"],
		["--", undefined, undefined],
	])("正确解析 %s", (input, modelReference, customInstructions) => {
		expect(parseCompactCommandArguments(input)).toEqual({ modelReference, customInstructions });
	});

	test.each([
		"--model",
		"--model=",
		'--model ""',
		'--model "unterminated',
		"--model --other",
		"--model=--other",
		"--models p/id",
		"--model p/id --model p/other",
	])("拒绝无效或重复选项 %s", (input) => expect(() => parseCompactCommandArguments(input)).toThrow());
});

describe("手动压缩模型参数及补全", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test.each([true, false])("不带 --model 直接压缩，保留默认模型行为（配置：%s）", async (configured) => {
		const context = await createContext({ configured });
		await context.start("保留验收标准");

		expect(context.compact).toHaveBeenCalledWith("保留验收标准", undefined);
		expect(context.harness.session.compactionModel?.id).toBe(configured ? "picker-default" : "picker-chat");
		expect(context.fakeThis.showSelector).not.toHaveBeenCalled();
		expect(context.saveDefault).not.toHaveBeenCalled();
		expect(context.setModel).not.toHaveBeenCalled();
	});

	test("--model 保存压缩默认模型，聊天模型不变且补充要求原样传递", async () => {
		const context = await createContext();
		const selected = context.harness.getModel("picker-temporary")!;
		const stop = vi.fn();
		context.fakeThis.loadingAnimation = { stop };
		await context.start(`--model ${selected.provider}/${selected.id} 保留验收标准\n  保留缩进`);

		expect(context.compact).toHaveBeenCalledWith(
			"保留验收标准\n  保留缩进",
			expect.objectContaining({ provider: selected.provider, id: selected.id }),
		);
		expect(context.fakeThis.showSelector).not.toHaveBeenCalled();
		expect(context.saveDefault).not.toHaveBeenCalled();
		expect(context.setModel).not.toHaveBeenCalled();
		expect(context.harness.settingsManager.getDefaultModel()).toBe("picker-chat");
		const reference = `${selected.provider}/${selected.id}`;
		expect(context.saveCompaction).toHaveBeenCalledWith(reference);
		expect(context.harness.settingsManager.getCompactionModel()).toBe(reference);
		expect(context.harness.settingsManager.getGlobalSettings().compaction?.model).toBe(reference);
		expect(context.fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("默认压缩模型已保存"));
		expect(stop).toHaveBeenCalledOnce();
		await context.start();
		expect(context.harness.session.compactionModel).toMatchObject({ id: selected.id });
		expect(context.compact).toHaveBeenLastCalledWith(undefined, undefined);
	});

	test("配置保存失败时不启动压缩，也不改变默认模型或加载状态", async () => {
		const context = await createContext();
		const selected = context.harness.getModel("picker-temporary")!;
		const previous = context.harness.settingsManager.getCompactionModel();
		const stop = vi.fn();
		context.fakeThis.loadingAnimation = { stop };
		context.saveCompaction.mockRejectedValueOnce(new Error("配置不可写"));
		await context.start(`--model ${selected.provider}/${selected.id}`);

		expect(context.fakeThis.showError).toHaveBeenCalledWith("配置不可写");
		expect(context.fakeThis.showStatus).not.toHaveBeenCalled();
		expect(context.compact).not.toHaveBeenCalled();
		expect(context.harness.settingsManager.getCompactionModel()).toBe(previous);
		expect(stop).not.toHaveBeenCalled();
		expect(context.fakeThis.statusContainer.clear).not.toHaveBeenCalled();
	});

	test("等待配置保存完成后才开始压缩", async () => {
		const context = await createContext();
		let complete: (() => void) | undefined;
		const saving = new Promise<void>((resolve) => {
			complete = resolve;
		});
		context.saveCompaction.mockReturnValueOnce(saving);
		const operation = context.start("--model picker-temporary");
		expect(context.saveCompaction).toHaveBeenCalledOnce();
		expect(context.compact).not.toHaveBeenCalled();
		expect(context.fakeThis.showStatus).not.toHaveBeenCalled();
		complete!();
		await operation;
		expect(context.compact).toHaveBeenCalledWith(undefined, expect.objectContaining({ id: "picker-temporary" }));
	});

	test("模型选择已保存后，即使本次摘要失败仍保留新默认值", async () => {
		const context = await createContext();
		const selected = context.harness.getModel("picker-temporary")!;
		context.compact.mockRejectedValueOnce(new Error("摘要服务失败"));
		await context.start(`--model ${selected.provider}/${selected.id}`);

		expect(context.harness.settingsManager.getCompactionModel()).toBe(`${selected.provider}/${selected.id}`);
		expect(context.fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("默认压缩模型已保存"));
		expect(context.setModel).not.toHaveBeenCalled();
		expect(context.saveDefault).not.toHaveBeenCalled();
	});

	test("消息不足时仍可保存选定的默认压缩模型，但不启动摘要", async () => {
		const context = await createContext({ withMessages: false });
		const selected = context.harness.getModel("picker-temporary")!;
		await context.start(`--model ${selected.provider}/${selected.id}`);

		expect(context.harness.settingsManager.getCompactionModel()).toBe(`${selected.provider}/${selected.id}`);
		expect(context.fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("默认压缩模型已保存"));
		expect(context.fakeThis.showWarning).toHaveBeenCalledWith("Nothing to compact (no messages yet)");
		expect(context.compact).not.toHaveBeenCalled();
	});

	test.each([false, true])("提交前刷新模型注册表（指定新默认模型：%s）", async (override) => {
		const context = await createContext();
		const registry = context.harness.session.modelRegistry;
		const configured = {
			...context.harness.getModel("picker-default")!,
			provider: "picker-after-refresh",
			id: "refreshed-default",
		};
		const reference = `${configured.provider}/${configured.id}`;
		context.harness.settingsManager.applyOverrides({ compaction: { model: reference } });
		const refresh = registry.refresh.bind(registry);
		vi.spyOn(registry, "refresh").mockImplementationOnce(() => {
			refresh();
			registry.registerProvider(configured.provider, {
				apiKey: "faux-key",
				baseUrl: configured.baseUrl,
				api: configured.api,
				models: [configured],
			});
		});
		await context.start(override ? `--model ${reference}` : undefined);

		expect(context.harness.session.compactionModel).toMatchObject({ id: configured.id });
		expect(context.compact).toHaveBeenCalledWith(
			undefined,
			override ? expect.objectContaining({ id: configured.id }) : undefined,
		);
	});

	test.each(["--model", "--model missing-provider/missing-model"])(
		"参数错误时不压缩也不停止加载状态：%s",
		async (input) => {
			const context = await createContext();
			const stop = vi.fn();
			context.fakeThis.loadingAnimation = { stop };
			await context.start(input);

			expect(context.fakeThis.showError).toHaveBeenCalledOnce();
			expect(context.compact).not.toHaveBeenCalled();
			expect(context.saveDefault).not.toHaveBeenCalled();
			expect(context.setModel).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
			expect(context.fakeThis.statusContainer.clear).not.toHaveBeenCalled();
		},
	);

	test("裸模型名有歧义时不静默选择其他提供商", async () => {
		const context = await createContext();
		const selected = context.harness.getModel("picker-temporary")!;
		context.harness.session.modelRegistry.registerProvider("another-picker", {
			apiKey: "faux-key",
			baseUrl: selected.baseUrl,
			api: selected.api,
			models: [selected],
		});
		await context.start(`--model ${selected.id}`);

		expect(context.compact).not.toHaveBeenCalled();
		expect(context.fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("唯一匹配"));
	});

	test.each(["prefixed-picker/summary", "prefixed-picker/prefixed-picker/summary"])(
		"支持模型 ID 已带提供商前缀的引用：%s",
		async (reference) => {
			const context = await createContext();
			const selected = {
				...context.harness.getModel("picker-temporary")!,
				provider: "prefixed-picker",
				id: "prefixed-picker/summary",
				name: "Friendly summary",
			};
			context.harness.session.modelRegistry.registerProvider(selected.provider, {
				apiKey: "faux-key",
				baseUrl: selected.baseUrl,
				api: selected.api,
				models: [selected],
			});
			const input = "/compact --model Friendly";
			const result = await context.createProvider().getSuggestions([input], 0, input.length, {
				signal: new AbortController().signal,
			});
			expect(result?.items).toContainEqual({
				value: `--model ${selected.provider}/${selected.id}`,
				label: "Friendly summary",
				description: selected.provider,
			});
			await context.start(`--model ${reference}`);

			expect(context.compact).toHaveBeenCalledWith(
				undefined,
				expect.objectContaining({ provider: selected.provider, id: selected.id }),
			);
		},
	);

	test("注册表刷新失败时报告错误，不启动压缩", async () => {
		const context = await createContext();
		vi.spyOn(context.harness.session.modelRegistry, "refresh").mockImplementationOnce(() => {
			throw new Error("刷新失败");
		});
		await context.start();
		expect(context.fakeThis.showError).toHaveBeenCalledWith("刷新失败");
		expect(context.compact).not.toHaveBeenCalled();
	});

	test("会话过小时不启动压缩", async () => {
		const context = await createContext({ withMessages: false });
		await context.start();
		expect(context.fakeThis.showWarning).toHaveBeenCalledWith("Nothing to compact (no messages yet)");
		expect(context.compact).not.toHaveBeenCalled();
	});

	test("补全 --model 参数并保留尾部空格，继续输入模型", async () => {
		const context = await createContext();
		const provider = context.createProvider();
		const input = "/compact --m";
		const result = await provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
		expect(result?.items[0]).toMatchObject({ value: "--model ", label: "--model" });
		const applied = provider.applyCompletion([input], 0, input.length, result!.items[0], result!.prefix);
		expect(applied.lines).toEqual(["/compact --model "]);
	});

	test.each(["--model ", "--model="])("补全模型（%s），不受聊天模型范围限制且保留后文", async (flag) => {
		const context = await createContext();
		context.harness.session.setScopedModels([{ model: context.harness.getModel() }]);
		const provider = context.createProvider();
		const beforeCursor = `/compact ${flag}picker-temp`;
		const input = `${beforeCursor} 保留结论`;
		const result = await provider.getSuggestions([input], 0, beforeCursor.length, {
			signal: new AbortController().signal,
		});
		expect(result?.items).toHaveLength(1);
		const item = result!.items[0];
		const selected = context.harness.getModel("picker-temporary")!;
		expect(item.value).toBe(`${flag}${selected.provider}/${selected.id}`);
		expect(context.saveCompaction).not.toHaveBeenCalled();
		expect(context.harness.settingsManager.getCompactionModel()).toContain("picker-default");
		const applied = provider.applyCompletion([input], 0, beforeCursor.length, item, result!.prefix);
		expect(applied.lines).toEqual([`/compact ${flag}${selected.provider}/${selected.id} 保留结论`]);
		await context.start(applied.lines[0].slice("/compact ".length));
		expect(context.compact).toHaveBeenCalledWith("保留结论", expect.objectContaining({ id: selected.id }));
	});

	test.each(["summary with spaces", 'summary"quoted', "summary\\path"])(
		"补全可正确往返含特殊字符的模型引用：%s",
		async (id) => {
			const context = await createContext();
			const selected = { ...context.harness.getModel("picker-temporary")!, provider: "quoted-picker", id };
			context.harness.session.modelRegistry.registerProvider(selected.provider, {
				apiKey: "faux-key",
				baseUrl: selected.baseUrl,
				api: selected.api,
				models: [selected],
			});
			const input = "/compact --model summary";
			const provider = context.createProvider();
			const result = await provider.getSuggestions([input], 0, input.length, {
				signal: new AbortController().signal,
			});
			const item = result!.items.find((candidate) => candidate.description === selected.provider)!;
			const applied = provider.applyCompletion([input], 0, input.length, item, result!.prefix);
			await context.start(applied.lines[0].slice("/compact ".length));
			expect(context.compact).toHaveBeenCalledWith(
				undefined,
				expect.objectContaining({ provider: selected.provider, id }),
			);
		},
	);

	test.each(["保留关键结论", "-- --model ", "--model picker-default 保留", "--model picker-default "])(
		"补充要求中不触发模型补全：%s",
		async (argumentsText) => {
			const context = await createContext();
			const input = `/compact ${argumentsText}`;
			expect(
				await context
					.createProvider()
					.getSuggestions([input], 0, input.length, { signal: new AbortController().signal }),
			).toBeNull();
		},
	);

	test("模型补全失败时显示错误，不产生未处理异常", async () => {
		const context = await createContext();
		vi.spyOn(context.harness.session.modelRegistry, "getAvailable").mockImplementationOnce(() => {
			throw new Error("候选加载失败");
		});
		const input = "/compact --model ";
		expect(
			await context
				.createProvider()
				.getSuggestions([input], 0, input.length, { signal: new AbortController().signal }),
		).toBeNull();
		expect(context.fakeThis.showError).toHaveBeenCalledWith("无法补全压缩模型：候选加载失败");
	});

	test.each([false, true])("编辑器提交 /compact 命令时正确传递参数（覆盖：%s）", async (override) => {
		const context = await createContext();
		const selected = context.harness.getModel("picker-temporary")!;
		const submitThis = {
			defaultEditor: { onSubmit: undefined as ((text: string) => Promise<void>) | undefined },
			editor: { setText: vi.fn() },
			handleCompactCommand: context.start,
		};
		const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
			this: typeof submitThis,
		) => void;
		setup.call(submitThis);
		await submitThis.defaultEditor.onSubmit!(
			override ? `/compact --model ${selected.provider}/${selected.id} 保留结论` : "/compact",
		);
		expect(submitThis.editor.setText).toHaveBeenCalledWith("");
		expect(context.compact).toHaveBeenCalledWith(
			override ? "保留结论" : undefined,
			override ? expect.objectContaining({ id: selected.id }) : undefined,
		);
	});

	test("普通模型选择器刷新失败时显示错误并允许取消", async () => {
		const context = await createContext();
		vi.spyOn(context.harness.session.modelRegistry, "refresh").mockImplementationOnce(() => {
			throw new Error("普通模型刷新失败");
		});
		const tui = { requestRender: vi.fn() };
		const ready = new Promise<void>((resolve) => tui.requestRender.mockImplementationOnce(() => resolve()));
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new ModelSelectorComponent(
			tui as unknown as TUI,
			context.harness.getModel(),
			context.harness.settingsManager,
			context.harness.session.modelRegistry,
			[],
			onSelect,
			onCancel,
		);
		await ready;
		expect(selector.render(120).join("\n")).toContain("普通模型刷新失败");
		selector.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(context.saveDefault).not.toHaveBeenCalled();
	});

	test("普通聊天模型选择仍保存默认模型", async () => {
		const context = await createContext();
		const selected = context.harness.getModel("picker-temporary")!;
		const tui = { requestRender: vi.fn() };
		const ready = new Promise<void>((resolve) => tui.requestRender.mockImplementationOnce(() => resolve()));
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			tui as unknown as TUI,
			selected,
			context.harness.settingsManager,
			context.harness.session.modelRegistry,
			[],
			onSelect,
			vi.fn(),
		);
		await ready;
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: selected.id }));
		expect(context.saveDefault).toHaveBeenCalledWith(selected.provider, selected.id);
	});
});
