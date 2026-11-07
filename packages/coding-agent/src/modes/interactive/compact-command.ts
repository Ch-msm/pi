import type { Api, Model } from "@earendil-works/pi-ai";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";

export interface CompactCommandArguments {
	modelReference?: string;
	customInstructions?: string;
}

/** 仅解析补充要求之前的选项，补充要求中的模型引用不作为参数处理。 */
export function parseCompactCommandArguments(input?: string): CompactCommandArguments {
	let rest = input?.trim() ?? "";
	let modelReference: string | undefined;

	if (rest === "--model" || rest.startsWith("--model=") || /^--model\s/.test(rest)) {
		const match = /^--model(?:=|\s+)("(?:\\.|[^"\\])*"|\S+)(?:\s+([\s\S]*))?$/.exec(rest);
		if (!match || match[1].startsWith("-")) {
			throw new Error("--model 需要指定模型，例如 /compact --model provider/model-id");
		}
		modelReference = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
		if (!modelReference) throw new Error("--model 不能指定空模型引用");
		rest = match[2] ?? "";
	}

	if (rest === "--") {
		rest = "";
	} else if (/^--\s/.test(rest)) {
		rest = rest.slice(2).trimStart();
	} else if (rest.startsWith("--")) {
		throw new Error(`未知或重复的压缩参数：${rest.split(/\s/, 1)[0]}。补充要求以 -- 开头时，请先添加 -- 分隔符。`);
	}

	return { modelReference, customInstructions: rest || undefined };
}

export function getCompactArgumentCompletions(
	prefix: string,
	getModels: () => Model<Api>[],
): AutocompleteItem[] | null {
	if ("--model".startsWith(prefix.trimStart())) {
		return [{ value: "--model ", label: "--model", description: "设置默认压缩模型并保存配置，不切换聊天模型" }];
	}

	const match = /^(\s*--model(?:[\t ]+|=))(\S*)$/.exec(prefix);
	if (!match) return null;

	const models = getModels();
	const filtered = fuzzyFilter(
		models,
		match[2],
		(model) => `${model.name} ${model.id} ${model.provider} ${model.provider}/${model.id}`,
	);
	if (filtered.length === 0) return null;

	// 补全提供器替换整个命令参数前缀，因此必须保留 --model 及其分隔符。
	return filtered.map((model) => {
		const reference = `${model.provider}/${model.id}`;
		const value = /[\s"\\]/.test(reference) ? JSON.stringify(reference) : reference;
		return { value: `${match[1]}${value}`, label: model.name, description: model.provider };
	});
}
