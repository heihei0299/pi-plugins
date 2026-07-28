import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	BtwBringToMainPreview,
	type BtwBringToMainPreviewAction,
	type BtwBringToMainSegment,
	type BtwBringToMainSummary,
	BtwMenuSelector,
	type BtwMenuSelectorAction,
	BtwTextRangeSelector,
	type BtwTextRangeSelectorState,
	buildQuickBringToMainSegments,
	estimateBringToMainTokens,
	formatBtwBringToMain,
	getAnsweredTurns,
	summarizeBringToMain,
} from "./bring-to-main.js";
import {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	completeSideThreadTurn,
	createSideThread,
	type SideQuestionAuth,
	type SideThread,
} from "./side-thread.js";
import {
	BtwAnsweringView,
	BtwTranscriptPager,
	type TranscriptPagerAction,
} from "./transcript-pager.js";

export {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	buildUserPrompt,
	completeSideQuestion,
	loadCompleteSimple,
} from "./side-thread.js";

const MAX_CONTEXT_CHARS = 40_000;
export const BTW_SETTINGS_FILE = "pi-btw.json";

export interface BtwSettings {
	model?: string;
	thinkingLevel?: BtwThinkingLevel;
}

export type BtwSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: BtwSettings };

interface LoadBtwThinkingLevelOptions {
	settingsPath?: string;
	warn?: (message: string) => void;
}

interface BtwModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(
		model: Model<Api>,
	): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
}

interface ResolveBtwModelOptions {
	settings: BtwSettings;
	currentModel: Model<Api> | undefined;
	modelRegistry: BtwModelRegistry;
	warn?: (message: string) => void;
}

export interface ResolvedBtwModel {
	model: Model<Api>;
	auth: SideQuestionAuth;
}

export function normalizeBtwSettings(value: unknown): BtwSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

	const settings: BtwSettings = {};
	if (Object.hasOwn(value, "model")) {
		const model = Reflect.get(value, "model");
		if (typeof model !== "string" || !parseBtwModelReference(model)) return undefined;
		settings.model = model;
	}
	if (Object.hasOwn(value, "thinkingLevel")) {
		const thinkingLevel = Reflect.get(value, "thinkingLevel");
		if (!isBtwThinkingLevel(thinkingLevel)) return undefined;
		settings.thinkingLevel = thinkingLevel;
	}
	return settings;
}

export function parseBtwModelReference(
	reference: string,
): { provider: string; modelId: string } | undefined {
	if (/\s/.test(reference)) return undefined;
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;
	return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
}

export async function resolveBtwModel({
	settings,
	currentModel,
	modelRegistry,
	warn,
}: ResolveBtwModelOptions): Promise<ResolvedBtwModel | undefined> {
	if (settings.model) {
		const fallback = currentModel
			? `${currentModel.provider}/${currentModel.id}`
			: "the current model";
		const reference = parseBtwModelReference(settings.model);
		if (!reference) {
			warn?.(`pi-btw model ${settings.model} is invalid; falling back to ${fallback}.`);
			return resolveBtwModel({ settings: {}, currentModel, modelRegistry, warn });
		}
		const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
		if (!configuredModel) {
			warn?.(`pi-btw model ${settings.model} was not found; falling back to ${fallback}.`);
		} else {
			const sameAsCurrent =
				configuredModel === currentModel ||
				(configuredModel.provider === currentModel?.provider &&
					configuredModel.id === currentModel.id);
			const fallbackAction = sameAsCurrent
				? "no distinct current model is available"
				: `falling back to ${fallback}`;
			try {
				const auth = await modelRegistry.getApiKeyAndHeaders(configuredModel);
				if (auth.ok && hasRequestAuth(auth)) return { model: configuredModel, auth };
				const reason = auth.ok ? "has no request credentials" : auth.error;
				warn?.(`pi-btw model ${settings.model} is unavailable (${reason}); ${fallbackAction}.`);
			} catch (error: unknown) {
				warn?.(
					`pi-btw model ${settings.model} credentials failed (${formatError(error)}); ${fallbackAction}.`,
				);
			}
			if (sameAsCurrent) return undefined;
		}
	}

	if (!currentModel) return undefined;
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(currentModel);
		if (auth.ok && hasRequestAuth(auth)) return { model: currentModel, auth };
	} catch {
		// The caller reports the final lack of an available model.
	}
	return undefined;
}

function hasRequestAuth(auth: SideQuestionAuth): boolean {
	return Boolean(
		auth.apiKey ||
			(auth.headers && Object.keys(auth.headers).length > 0) ||
			(auth.env && Object.keys(auth.env).length > 0),
	);
}

export async function readBtwSettings(
	settingsPath = join(getAgentDir(), BTW_SETTINGS_FILE),
): Promise<BtwSettingsLoadResult> {
	let contents: string;
	try {
		contents = await readFile(settingsPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: `${settingsPath}: ${formatError(error)}` };
	}

	try {
		const settings = normalizeBtwSettings(JSON.parse(contents) as unknown);
		if (settings) return { kind: "loaded", settings };
		return { kind: "invalid", reason: `${settingsPath}: invalid settings shape` };
	} catch (error: unknown) {
		return { kind: "invalid", reason: `${settingsPath}: ${formatError(error)}` };
	}
}

export async function loadBtwThinkingLevel(
	currentThinkingLevel: BtwThinkingLevel,
	options: LoadBtwThinkingLevelOptions = {},
): Promise<BtwThinkingLevel> {
	const settings = await readBtwSettings(options.settingsPath);
	if (settings.kind === "missing") return currentThinkingLevel;
	if (settings.kind === "loaded") {
		return settings.settings.thinkingLevel ?? currentThinkingLevel;
	}

	options.warn?.(
		`pi-btw settings ignored: ${settings.reason}; expected optional model "provider/model-id" and thinkingLevel "${BTW_THINKING_LEVELS.join('" | "')}". Using current Pi thinking level.`,
	);
	return currentThinkingLevel;
}

function isBtwThinkingLevel(value: unknown): value is BtwThinkingLevel {
	return BTW_THINKING_LEVELS.includes(value as BtwThinkingLevel);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function btw(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive TUI mode", "error");
				return;
			}

			const settings = await loadSettingsForCommand(ctx);
			const resolution = await resolveBtwModelWithLoader(settings, ctx);
			if (resolution.kind === "cancelled") {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (resolution.kind === "unavailable") {
				ctx.ui.notify("No available model for /btw", "error");
				return;
			}

			await runBtwThread({
				initialQuestion: question || undefined,
				selected: resolution.selected,
				thinkingLevel: settings.thinkingLevel ?? pi.getThinkingLevel(),
				ctx,
			});
		},
	});
}

async function loadSettingsForCommand(ctx: ExtensionCommandContext): Promise<BtwSettings> {
	const settingsResult = await readBtwSettings();
	if (settingsResult.kind === "loaded") return settingsResult.settings;
	if (settingsResult.kind === "invalid") {
		ctx.ui.notify(`pi-btw settings ignored: ${settingsResult.reason}`, "warning");
	}
	return {};
}

type ModelResolutionOutcome =
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "selected"; selected: ResolvedBtwModel };

async function resolveBtwModelWithLoader(
	settings: BtwSettings,
	ctx: ExtensionCommandContext,
): Promise<ModelResolutionOutcome> {
	return ctx.ui.custom<ModelResolutionOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Resolving /btw model credentials...");
		let settled = false;
		loader.onAbort = () => {
			if (settled) return;
			settled = true;
			done({ kind: "cancelled" });
		};

		resolveBtwModel({
			settings,
			currentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			warn: (message) => {
				if (!settled) ctx.ui.notify(message, "warning");
			},
		})
			.then((selected) => {
				if (settled) return;
				settled = true;
				done(selected ? { kind: "selected", selected } : { kind: "unavailable" });
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				done({ kind: "unavailable" });
			});

		return loader;
	});
}

interface RunBtwThreadDependencies {
	ask?: typeof askThreadQuestion;
	interact?: typeof showThreadComposer;
	chooseBringToMain?: typeof chooseBringToMain;
	deliverBringToMain?: typeof loadBringToMainDraft;
}

export type BtwThreadResult = { kind: "closed" };

type BtwBringToMainChoice =
	| BtwThreadResult
	| {
			kind: "bringToMain";
			draft: string;
			summary: BtwBringToMainSummary;
			selectionState?: BtwTextRangeSelectorState;
	  }
	| { kind: "back" };

type BtwBringToMainDelivery = "loaded" | "back" | "closed";

interface RunBtwThreadOptions {
	initialQuestion?: string;
	selected: ResolvedBtwModel;
	thinkingLevel: BtwThinkingLevel;
	ctx: ExtensionCommandContext;
	dependencies?: RunBtwThreadDependencies;
}

export async function runBtwThread({
	initialQuestion,
	selected,
	thinkingLevel,
	ctx,
	dependencies = {},
}: RunBtwThreadOptions): Promise<BtwThreadResult> {
	const ask = dependencies.ask ?? askThreadQuestion;
	const interact = dependencies.interact ?? showThreadComposer;
	const chooseBringToMainAction = dependencies.chooseBringToMain ?? chooseBringToMain;
	const deliverBringToMainDraft = dependencies.deliverBringToMain ?? loadBringToMainDraft;
	const thread = createSideThread(buildConversationContext(ctx.sessionManager.getBranch()));
	let pendingQuestion = initialQuestion;
	let composerDraft: string | undefined;

	while (true) {
		if (!pendingQuestion) {
			const action = await interact(thread, thread.turns.length > 0, ctx, composerDraft);
			if (action.kind === "close") return { kind: "closed" };
			if (action.kind === "bringToMain") {
				const choice = await chooseBringToMainAction(thread, ctx);
				if (choice.kind === "closed") return choice;
				if (choice.kind === "back") {
					composerDraft = action.questionDraft;
					continue;
				}
				const delivery = await deliverBringToMainDraft(choice.draft, ctx, choice.summary);
				if (delivery === "loaded" || delivery === "closed") return { kind: "closed" };
				composerDraft = action.questionDraft;
				continue;
			}
			composerDraft = undefined;
			pendingQuestion = action.question;
		}

		const result = await ask(thread, pendingQuestion, selected, thinkingLevel, ctx);
		if (result.kind === "aborted") {
			ctx.ui.notify("Cancelled", "info");
			return { kind: "closed" };
		}
		if (result.kind === "error") {
			thread.turns.push({
				kind: "error",
				question: pendingQuestion,
				answer: result.message,
			});
		}

		pendingQuestion = undefined;
	}
}

type BtwCustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => Component;

async function showBtwCustomPreservingEditor<T>(
	ctx: ExtensionCommandContext,
	factory: BtwCustomFactory<T>,
): Promise<T> {
	let liveEditorText = ctx.ui.getEditorText();
	const result = await ctx.ui.custom<T>((tui, theme, keybindings, done) =>
		factory(tui, theme, keybindings, (value) => {
			liveEditorText = ctx.ui.getEditorText();
			done(value);
		}),
	);
	if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
	return result;
}

interface ChooseBringToMainDependencies {
	showMenu?: typeof showBtwMenu;
	showPreview?: typeof showBringToMainPreview;
}

export async function chooseBringToMain(
	thread: SideThread,
	ctx: ExtensionCommandContext,
	dependencies: ChooseBringToMainDependencies = {},
): Promise<BtwBringToMainChoice> {
	const answered = getAnsweredTurns(thread.turns);
	if (answered.length === 0) return { kind: "back" };
	const showMenu = dependencies.showMenu ?? showBtwMenu;
	const showPreview = dependencies.showPreview ?? showBringToMainPreview;
	const makeChoice = (segments: readonly BtwBringToMainSegment[]) => ({
		kind: "bringToMain" as const,
		draft: formatBtwBringToMain(segments),
		summary: summarizeBringToMain(segments),
	});

	const latestSegments = buildQuickBringToMainSegments(thread.turns, { kind: "latest" });
	const entireSegments = buildQuickBringToMainSegments(thread.turns, { kind: "entire" });
	const latestOption = `Latest question and answer  1 Q&A · ~${estimateBringToMainTokens(latestSegments)} tokens`;
	const fromOption = "From a question onward…  Choose a starting question";
	const exactOption = "Select exact text…  Lines or characters";
	const entireOption = `Entire side thread  ${answered.length} Q&A · ~${estimateBringToMainTokens(entireSegments)} tokens`;
	const cancelOption = "Cancel  Return to the side thread";
	let selectedScope: string | undefined;

	while (true) {
		const scopeResult = await showMenu(
			ctx,
			"Bring what back to the main thread?",
			[latestOption, fromOption, exactOption, entireOption, cancelOption],
			selectedScope,
		);
		if (scopeResult.kind === "close") return { kind: "closed" };
		if (scopeResult.kind === "back" || scopeResult.value === cancelOption) return { kind: "back" };
		const scope = scopeResult.value;
		selectedScope = scope;
		if (scope === latestOption) return makeChoice(latestSegments);
		if (scope === entireOption) {
			const choice = makeChoice(entireSegments);
			const preview = await showPreview(ctx, choice.draft, choice.summary);
			if (preview.kind === "close") return { kind: "closed" };
			if (preview.kind === "back") continue;
			return choice;
		}
		if (scope === fromOption) {
			const questions = answered.map(
				(turn, index) => `${index + 1}. ${truncatePreview(sanitizeSingleLine(turn.question))}`,
			);
			let selectedQuestion: string | undefined;
			while (true) {
				const questionResult = await showMenu(
					ctx,
					"Start from which question?",
					questions,
					selectedQuestion,
				);
				if (questionResult.kind === "close") return { kind: "closed" };
				if (questionResult.kind === "back") break;
				const answeredTurnIndex = questions.indexOf(questionResult.value);
				if (answeredTurnIndex < 0) continue;
				selectedQuestion = questionResult.value;
				const choice = makeChoice(
					buildQuickBringToMainSegments(thread.turns, { kind: "from", answeredTurnIndex }),
				);
				const preview = await showPreview(ctx, choice.draft, choice.summary);
				if (preview.kind === "close") return { kind: "closed" };
				if (preview.kind === "back") continue;
				return choice;
			}
			continue;
		}

		if (scope !== exactOption) continue;
		let selectionState: BtwTextRangeSelectorState | undefined;
		while (true) {
			const selectedRange = await showBtwCustomPreservingEditor<BtwBringToMainChoice>(
				ctx,
				(tui, theme, keybindings, done) => {
					let selector: BtwTextRangeSelector;
					selector = new BtwTextRangeSelector(
						tui,
						theme,
						keybindings,
						thread.turns,
						(action) => {
							if (action.kind === "back") done({ kind: "back" });
							else if (action.kind === "close") done({ kind: "closed" });
							else done({ ...makeChoice(action.segments), selectionState: selector.getState() });
						},
						selectionState,
					);
					return selector;
				},
			);
			if (selectedRange.kind === "closed") return selectedRange;
			if (selectedRange.kind === "back") break;
			const preview = await showPreview(ctx, selectedRange.draft, selectedRange.summary);
			if (preview.kind === "close") return { kind: "closed" };
			if (preview.kind === "back") {
				selectionState = selectedRange.selectionState;
				continue;
			}
			return {
				kind: "bringToMain",
				draft: selectedRange.draft,
				summary: selectedRange.summary,
			};
		}
	}
}

async function showBringToMainPreview(
	ctx: ExtensionCommandContext,
	draft: string,
	summary: BtwBringToMainSummary,
): Promise<BtwBringToMainPreviewAction> {
	return showBtwCustomPreservingEditor<BtwBringToMainPreviewAction>(
		ctx,
		(tui, theme, keybindings, done) =>
			new BtwBringToMainPreview(tui, theme, keybindings, draft, summary, done),
	);
}

async function showBtwMenu(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly string[],
	initialValue?: string,
): Promise<BtwMenuSelectorAction> {
	return showBtwCustomPreservingEditor<BtwMenuSelectorAction>(
		ctx,
		(tui, theme, keybindings, done) =>
			new BtwMenuSelector(tui, theme, keybindings, title, options, done, initialValue),
	);
}

export async function loadBringToMainDraft(
	draft: string,
	ctx: ExtensionCommandContext,
	summary: BtwBringToMainSummary,
): Promise<BtwBringToMainDelivery> {
	const describeContent = () =>
		`${summary.messages} ${summary.messages === 1 ? "message" : "messages"} (~${summary.tokens} ${summary.tokens === 1 ? "token" : "tokens"})`;
	const existing = ctx.ui.getEditorText();
	if (!existing.trim()) {
		ctx.ui.setEditorText(draft);
		ctx.ui.notify(
			`Brought ${describeContent()} to the main editor. Review and submit when ready.`,
			"info",
		);
		return "loaded";
	}

	const appendOption = "Append after current draft  Recommended";
	const replaceOption = "⚠ Replace current draft  Discards current editor text";
	const cancelOption = "Cancel  Return to the side thread";
	while (true) {
		const action = await showBtwMenu(ctx, "The main editor already has a draft", [
			appendOption,
			replaceOption,
			cancelOption,
		]);
		if (action.kind === "close") return "closed";
		if (action.kind === "back" || action.value === cancelOption) return "back";
		if (action.value === appendOption) {
			ctx.ui.setEditorText(`${ctx.ui.getEditorText()}\n\n${draft}`);
			ctx.ui.notify(
				`Appended ${describeContent()} to the existing main-editor draft. Review and submit when ready.`,
				"info",
			);
			return "loaded";
		}
		if (action.value !== replaceOption) continue;

		const current = ctx.ui.getEditorText();
		const characters = [...current].length;
		const confirmed = await showBtwMenu(
			ctx,
			`Replace the current ${characters}-character editor draft?`,
			["Back  Keep current editor text", "⚠ Replace current draft  Cannot be undone"],
		);
		if (confirmed.kind === "close") return "closed";
		if (confirmed.kind === "back" || confirmed.value === "Back  Keep current editor text") continue;
		if (confirmed.value !== "⚠ Replace current draft  Cannot be undone") continue;
		if (ctx.ui.getEditorText() !== current) {
			ctx.ui.notify(
				"The main editor changed during confirmation. Review the updated draft and choose again.",
				"warning",
			);
			continue;
		}
		ctx.ui.setEditorText(draft);
		ctx.ui.notify(
			`Replaced the main-editor draft with ${describeContent()}. Review and submit when ready.`,
			"info",
		);
		return "loaded";
	}
}

function truncatePreview(text: string): string {
	return text.length <= 72 ? text : `${text.slice(0, 69)}…`;
}

async function askThreadQuestion(
	thread: SideThread,
	question: string,
	selected: ResolvedBtwModel,
	thinkingLevel: BtwThinkingLevel,
	ctx: ExtensionCommandContext,
) {
	return ctx.ui.custom<Awaited<ReturnType<typeof completeSideThreadTurn>>>(
		(tui, theme, _keybindings, done) => {
			let settled = false;
			const view = new BtwAnsweringView(tui, theme, thread.turns, question, () => {
				if (settled) return;
				settled = true;
				done({ kind: "aborted" });
			});
			completeSideThreadTurn({
				thread,
				question,
				model: selected.model,
				thinkingLevel,
				auth: selected.auth,
				signal: view.signal,
			}).then((result) => {
				if (settled) return;
				settled = true;
				view.finish();
				done(result);
			});
			return view;
		},
	);
}

async function showThreadComposer(
	thread: SideThread,
	startAtBottom: boolean,
	ctx: ExtensionCommandContext,
	initialQuestion?: string,
): Promise<TranscriptPagerAction> {
	return ctx.ui.custom<TranscriptPagerAction>(
		(tui, theme, _keybindings, done) =>
			new BtwTranscriptPager(tui, theme, thread.turns, done, {
				startAtBottom,
				initialQuestion,
			}),
	);
}

export function sanitizeSingleLine(text: string) {
	return [...text.replace(/[\r\n\t]/g, " ")]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && (code < 127 || code > 159);
		})
		.join("")
		.replace(/ +/g, " ")
		.trim();
}

type MessageContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	result?: unknown;
};

type SessionMessage = {
	role?: string;
	content?: unknown;
	stopReason?: string;
};

type SessionEntry = {
	type: string;
	message?: SessionMessage;
};

export function buildConversationContext(entries: readonly SessionEntry[]) {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const contentLines = extractContentLines(entry.message.content);
		if (contentLines.length === 0) continue;

		const label = role === "user" ? "User" : "Assistant";
		const status =
			entry.message.stopReason && entry.message.stopReason !== "stop"
				? ` (${entry.message.stopReason})`
				: "";
		sections.push(`${label}${status}: ${contentLines.join("\n")}`);
	}

	return truncateFromStart(sections.join("\n\n"), MAX_CONTEXT_CHARS);
}

function extractContentLines(content: unknown): string[] {
	if (typeof content === "string") return [content.trim()].filter(Boolean);
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			lines.push(block.text.trim());
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`Tool call: ${block.name}(${formatJson(block.arguments)})`);
		} else if (block.type === "toolResult" && typeof block.name === "string") {
			lines.push(`Tool result from ${block.name}: ${formatJson(block.result)}`);
		}
	}
	return lines.filter(Boolean);
}

function formatJson(value: unknown) {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function truncateFromStart(text: string, maxChars: number) {
	if (text.length <= maxChars) return text;
	return `[Earlier context omitted; showing the last ${maxChars} characters.]\n${text.slice(-maxChars)}`;
}
