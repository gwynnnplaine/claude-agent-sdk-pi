import { createSdkMcpServer, query, type SDKMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { calculateCost, createAssistantMessageEventStream, getModels, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { loadProviderSettings } from "./config/providerSettings.js";
import { GLOBAL_AGENTS_PATH, GLOBAL_SKILLS_ROOT, MCP_SERVER_NAME, MCP_TOOL_PREFIX, PROJECT_SKILLS_ROOT, PROVIDER_ID, SKILLS_ALIAS_GLOBAL, SKILLS_ALIAS_PROJECT, TOOL_EXECUTION_DENIED_MESSAGE } from "./core/constants.js";
import { toProviderError } from "./core/errors.js";
import { createFeatureRuntime, reportFeatureError, type ClaudeAgentSdkFeature, type FeatureRuntime } from "./core/features.js";
import { mapToolArgs } from "./mapping/toolArgs.js";
import { BUILTIN_TOOL_NAMES, DEFAULT_TOOLS, PI_TO_SDK_TOOL_NAME, mapPiToolNameToSdk, mapSdkToolNameToPi } from "./mapping/toolNames.js";

const TOOL_WATCH_CUSTOM_TYPE = "claude-agent-sdk-tool-watch";
const MAX_TRACKED_TOOL_EXECUTIONS = 256;
const MAX_TRACKED_TOOL_CONTENT_CHARS = 4000;
const MAX_LEDGER_TOOL_RESULTS = 4;
const MAX_LEDGER_TOOL_CONTENT_CHARS = 1200;

type ToolWatchCustomEntryData = {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type PendingToolCall = {
	toolName: string;
	timestamp: number;
};

type TrackedToolExecution = {
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type SessionToolWatchState = {
	pendingToolCalls: Map<string, PendingToolCall>;
	completedToolCalls: Map<string, TrackedToolExecution>;
};

const toolWatchStateBySession = new Map<string, SessionToolWatchState>();
let activeSessionKey: string | undefined;
let extensionApi: ExtensionAPI | undefined;

function createEmptyToolWatchState(): SessionToolWatchState {
	return {
		pendingToolCalls: new Map(),
		completedToolCalls: new Map(),
	};
}

function getOrCreateToolWatchState(sessionKey: string): SessionToolWatchState {
	const existing = toolWatchStateBySession.get(sessionKey);
	if (existing) return existing;
	const created = createEmptyToolWatchState();
	toolWatchStateBySession.set(sessionKey, created);
	return created;
}

function getSessionKeyFromSessionId(sessionId?: string): string | undefined {
	if (!sessionId) return undefined;
	return `session:${sessionId}`;
}

function getSessionKeyFromStreamOptions(options?: SimpleStreamOptions): string | undefined {
	const fromOptions = getSessionKeyFromSessionId((options as { sessionId?: string } | undefined)?.sessionId);
	if (fromOptions) return fromOptions;
	return activeSessionKey;
}

function getSessionKeyFromContext(
	ctx?: { sessionManager?: { getSessionId?: () => string } | undefined } | undefined,
): string | undefined {
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (!sessionId) return undefined;
	return getSessionKeyFromSessionId(sessionId);
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n...[truncated]`;
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function contentToPlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const contentBlock = block as { type?: string; text?: string; mimeType?: string };
			if (contentBlock.type === "text") return contentBlock.text ?? "";
			if (contentBlock.type === "image") return `[image:${contentBlock.mimeType ?? "unknown"}]`;
			if (contentBlock.type) return `[${contentBlock.type}]`;
			return "";
		})
		.filter((line) => line.length > 0)
		.join("\n");
}

function extractToolExecutionContent(result: unknown): string {
	if (result && typeof result === "object" && "content" in result) {
		const objectResult = result as { content?: unknown };
		const text = contentToPlainText(objectResult.content);
		if (text) return truncateText(text, MAX_TRACKED_TOOL_CONTENT_CHARS);
	}
	const fallback = stringifyUnknown(result);
	return truncateText(fallback, MAX_TRACKED_TOOL_CONTENT_CHARS);
}

function collectAssistantToolCalls(message: unknown): Array<{ id: string; name: string }> {
	if (!message || typeof message !== "object") return [];
	const assistantMessage = message as {
		role?: string;
		content?: Array<{ type?: string; id?: string; name?: string }>;
	};
	if (assistantMessage.role !== "assistant" || !Array.isArray(assistantMessage.content)) return [];
	return assistantMessage.content
		.filter((block): block is { type: "toolCall"; id: string; name: string } => {
			return block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string";
		})
		.map((block) => ({ id: block.id, name: block.name }));
}

function trackPendingToolCall(sessionKey: string, toolCallId: string, toolName: string, timestamp: number): void {
	const state = getOrCreateToolWatchState(sessionKey);
	if (state.completedToolCalls.has(toolCallId)) return;
	state.pendingToolCalls.set(toolCallId, { toolName, timestamp });
}

function trackCompletedToolCall(sessionKey: string, execution: TrackedToolExecution): void {
	const state = getOrCreateToolWatchState(sessionKey);
	state.pendingToolCalls.delete(execution.toolCallId);
	state.completedToolCalls.delete(execution.toolCallId);
	state.completedToolCalls.set(execution.toolCallId, execution);
	while (state.completedToolCalls.size > MAX_TRACKED_TOOL_EXECUTIONS) {
		const oldestKey = state.completedToolCalls.keys().next().value;
		if (!oldestKey) break;
		state.completedToolCalls.delete(oldestKey);
	}
}

function hydrateToolWatchStateFromEntries(sessionKey: string, entries: Array<Record<string, any>>): void {
	toolWatchStateBySession.set(sessionKey, createEmptyToolWatchState());
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			const messageTimestamp = typeof message?.timestamp === "number" ? message.timestamp : Date.now();
			if (message?.role === "assistant") {
				for (const toolCall of collectAssistantToolCalls(message)) {
					trackPendingToolCall(sessionKey, toolCall.id, toolCall.name, messageTimestamp);
				}
				continue;
			}
			if (message?.role === "toolResult") {
				if (typeof message.toolCallId === "string" && typeof message.toolName === "string") {
					trackCompletedToolCall(sessionKey, {
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						content: truncateText(contentToPlainText(message.content), MAX_TRACKED_TOOL_CONTENT_CHARS),
						isError: message.isError === true,
						timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
					});
				}
			}
			continue;
		}
		if (entry.type === "custom" && entry.customType === TOOL_WATCH_CUSTOM_TYPE) {
			const data = entry.data as ToolWatchCustomEntryData | undefined;
			if (!data || data.type !== "tool_execution_end") continue;
			if (!data.toolCallId || !data.toolName) continue;
			trackCompletedToolCall(sessionKey, {
				toolCallId: data.toolCallId,
				toolName: data.toolName,
				content: truncateText(data.content ?? "", MAX_TRACKED_TOOL_CONTENT_CHARS),
				isError: data.isError === true,
				timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
			});
		}
	}
}

function reconcileToolWatchStateWithContext(sessionKey: string, context: Context): void {
	const state = toolWatchStateBySession.get(sessionKey);
	if (!state) return;
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const toolCall of collectAssistantToolCalls(message)) {
				if (!state.completedToolCalls.has(toolCall.id)) {
					trackPendingToolCall(sessionKey, toolCall.id, toolCall.name, message.timestamp);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			state.pendingToolCalls.delete(message.toolCallId);
			if (!state.completedToolCalls.has(message.toolCallId)) {
				trackCompletedToolCall(sessionKey, {
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					content: truncateText(contentToPlainText(message.content), MAX_TRACKED_TOOL_CONTENT_CHARS),
					isError: message.isError,
					timestamp: message.timestamp,
				});
			}
		}
	}
}

function buildToolWatchPromptNote(
	sessionKey: string | undefined,
	context: Context,
	customToolNameToSdk?: Map<string, string>,
): string | undefined {
	if (!sessionKey) return undefined;
	const state = toolWatchStateBySession.get(sessionKey);
	if (!state) return undefined;

	const toolResultIdsInContext = new Set<string>();
	const assistantToolIdsInContext = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const toolCall of collectAssistantToolCalls(message)) {
				assistantToolIdsInContext.add(toolCall.id);
			}
			continue;
		}
		if (message.role === "toolResult") {
			toolResultIdsInContext.add(message.toolCallId);
		}
	}

	const recoveredExecutions = Array.from(state.completedToolCalls.values())
		.filter((execution) => {
			if (toolResultIdsInContext.has(execution.toolCallId)) return false;
			return assistantToolIdsInContext.has(execution.toolCallId) || state.pendingToolCalls.has(execution.toolCallId);
		})
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, MAX_LEDGER_TOOL_RESULTS);

	const unresolvedToolCalls = Array.from(state.pendingToolCalls.entries())
		.filter(([toolCallId]) => {
			if (toolResultIdsInContext.has(toolCallId)) return false;
			return assistantToolIdsInContext.has(toolCallId);
		})
		.sort((a, b) => b[1].timestamp - a[1].timestamp)
		.slice(0, MAX_LEDGER_TOOL_RESULTS);

	if (!recoveredExecutions.length && !unresolvedToolCalls.length) return undefined;

	const parts: string[] = [];

	if (recoveredExecutions.length) {
		for (const execution of recoveredExecutions) {
			const sdkToolName = mapPiToolNameToSdk(execution.toolName, customToolNameToSdk);
			const status = execution.isError ? "error" : "ok";
			const content = truncateText(execution.content || "(empty tool result)", MAX_LEDGER_TOOL_CONTENT_CHARS);
			parts.push(
				`TOOL RESULT (recovered ${sdkToolName}, id=${execution.toolCallId}, status=${status}):\n${content}`,
			);
		}
	}

	if (unresolvedToolCalls.length) {
		for (const [toolCallId, pending] of unresolvedToolCalls) {
			const sdkToolName = mapPiToolNameToSdk(pending.toolName, customToolNameToSdk);
			parts.push(
				`TOOL RESULT (missing execution ${sdkToolName}, id=${toolCallId}, status=error):\n` +
					"Tool execution did not complete or its result was not observed. Do not guess. Call the tool again.",
			);
		}
	}

	return parts.join("\n\n");
}

const MODELS = getModels("anthropic").map((model) => ({
	id: model.id,
	name: model.name,
	reasoning: model.reasoning,
	input: model.input,
	cost: model.cost,
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
}));


function buildPromptBlocks(
	context: Context,
	customToolNameToSdk: Map<string, string> | undefined,
	toolWatchNote?: string,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];

	const pushText = (text: string) => {
		blocks.push({ type: "text", text });
	};

	const pushImage = (image: ImageContent) => {
		blocks.push({
			type: "image",
			source: {
				type: "base64",
				media_type: image.mimeType as Base64ImageSource["media_type"],
				data: image.data,
			},
		});
	};

	const pushPrefix = (label: string) => {
		const prefix = `${blocks.length ? "\n\n" : ""}${label}\n`;
		pushText(prefix);
	};

	const appendContentBlocks = (
		content:
			| string
			| Array<{
					type: string;
					text?: string;
					data?: string;
					mimeType?: string;
				}>,
	): boolean => {
		if (typeof content === "string") {
			if (content.length > 0) {
				pushText(content);
				return content.trim().length > 0;
			}
			return false;
		}
		if (!Array.isArray(content)) return false;
		let hasText = false;
		for (const block of content) {
			if (block.type === "text") {
				const text = block.text ?? "";
				if (text.trim().length > 0) hasText = true;
				pushText(text);
				continue;
			}
			if (block.type === "image") {
				pushImage(block as ImageContent);
				continue;
			}
			pushText(`[${block.type}]`);
		}
		return hasText;
	};

	for (const message of context.messages) {
		if (message.role === "user") {
			pushPrefix("USER:");
			const hasText = appendContentBlocks(message.content);
			if (!hasText) {
				pushText("(see attached image)");
			}
			continue;
		}

		if (message.role === "assistant") {
			pushPrefix("ASSISTANT:");
			const text = contentToText(message.content, customToolNameToSdk);
			if (text.length > 0) {
				pushText(text);
			}
			continue;
		}

		if (message.role === "toolResult") {
			const header = `TOOL RESULT (historical ${mapPiToolNameToSdk(message.toolName, customToolNameToSdk)}, id=${message.toolCallId}):`;
			pushPrefix(header);
			const hasText = appendContentBlocks(message.content);
			if (!hasText) {
				pushText("(see attached image)");
			}
		}
	}

	if (toolWatchNote && toolWatchNote.trim().length > 0) {
		pushPrefix("RECOVERED TOOL RESULTS:");
		pushText(toolWatchNote.trim());
	}

	if (!blocks.length) return [{ type: "text", text: "" }];

	return blocks;
}

function buildPromptStream(promptBlocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	async function* generator() {
		const message: SDKUserMessage = {
			type: "user",
			message: {
				role: "user",
				content: promptBlocks,
			} as MessageParam,
			parent_tool_use_id: null,
			session_id: "prompt",
		};

		yield message;
	}

	return generator();
}

function contentToText(
	content:
		| string
		| Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		}>,
	customToolNameToSdk?: Map<string, string>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") {
				const args = block.arguments ? JSON.stringify(block.arguments) : "{}";
				const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
				return `Historical tool call (non-executable): ${toolName} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}


function extractSkillsAppend(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const startIndex = systemPrompt.indexOf(startMarker);
	if (startIndex === -1) return undefined;
	const endIndex = systemPrompt.indexOf(endMarker, startIndex);
	if (endIndex === -1) return undefined;
	const skillsBlock = systemPrompt.slice(startIndex, endIndex + endMarker.length).trim();
	return rewriteSkillsLocations(skillsBlock);
}


function rewriteSkillsLocations(skillsBlock: string): string {
	return skillsBlock.replace(/<location>([^<]+)<\/location>/g, (_match, location: string) => {
		let rewritten = location;
		if (location.startsWith(GLOBAL_SKILLS_ROOT)) {
			const relPath = relative(GLOBAL_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_GLOBAL}/${relPath}`.replace(/\/\/+/g, "/");
		} else if (location.startsWith(PROJECT_SKILLS_ROOT)) {
			const relPath = relative(PROJECT_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_PROJECT}/${relPath}`.replace(/\/\/+/g, "/");
		}
		return `<location>${rewritten}</location>`;
	});
}

function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
	return undefined;
}

function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function extractAgentsAppend(): string | undefined {
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
}

function sanitizeAgentsContent(content: string): string {
	let sanitized = content;
	sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
	sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
	sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
	sanitized = sanitized.replace(/\bpi\b/gi, "environment");
	return sanitized;
}


function resolveSdkTools(context: Context): {
	sdkTools: string[];
	customTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	if (!context.tools) {
		return {
			sdkTools: [...DEFAULT_TOOLS],
			customTools: [],
			customToolNameToSdk: new Map(),
			customToolNameToPi: new Map(),
		};
	}

	const sdkTools = new Set<string>();
	const customTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	for (const tool of context.tools) {
		const normalized = tool.name.toLowerCase();
		if (BUILTIN_TOOL_NAMES.has(normalized)) {
			const sdkName = PI_TO_SDK_TOOL_NAME[normalized];
			if (sdkName) sdkTools.add(sdkName);
			continue;
		}
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		customTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(normalized, sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { sdkTools: Array.from(sdkTools), customTools, customToolNameToSdk, customToolNameToPi };
}

function buildCustomToolServers(customTools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!customTools.length) return undefined;

	const mcpTools = customTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as unknown,
		handler: async () => ({
			content: [{ type: "text", text: TOOL_EXECUTION_DENIED_MESSAGE }],
			isError: true,
		}),
	}));

	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		tools: mcpTools,
	});

	return { [MCP_SERVER_NAME]: server };
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		default:
			return "stop";
	}
}

type ThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
type NonXhighThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

const DEFAULT_THINKING_BUDGETS: Record<NonXhighThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 16384,
	high: 31999,
};

// NOTE: "xhigh" is unavailable in the TUI because pi-ai's supportsXhigh()
// doesn't recognize the "claude-agent-sdk" api type. As a workaround, opus-4-6
// gets shifted budgets so "high" uses the budget that xhigh would normally use.
const OPUS_46_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 31999,
	high: 63999,
	// Future-proofing: pi currently won't surface "xhigh" for this provider because
	// pi-ai's supportsXhigh() doesn't recognize the "claude-agent-sdk" api type.
	// If/when that changes, we can shift the budgets to 2048, 8192, 16384, 31999, 63999.
	xhigh: 63999,
};

function mapThinkingTokens(
	reasoning?: ThinkingLevel,
	modelId?: string,
	thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): number | undefined {
	if (!reasoning) return undefined;

	const isOpus46 = modelId?.includes("opus-4-6") || modelId?.includes("opus-4.6");
	if (isOpus46) {
		return OPUS_46_THINKING_BUDGETS[reasoning];
	}

	const effectiveReasoning: NonXhighThinkingLevel = reasoning === "xhigh" ? "high" : reasoning;

	const customBudgets = thinkingBudgets as (Partial<Record<NonXhighThinkingLevel, number>> | undefined);
	const customBudget = customBudgets?.[effectiveReasoning];
	if (typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0) {
		return customBudget;
	}

	return DEFAULT_THINKING_BUDGETS[effectiveReasoning];
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try {
		return JSON.parse(input);
	} catch {
		return fallback;
	}
}

function createStreamClaudeAgentSdk(featureRuntime: FeatureRuntime) {
	return function streamClaudeAgentSdk(
		model: Model<any>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
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

		let sdkQuery: ReturnType<typeof query> | undefined;
		let wasAborted = false;
		const requestAbort = () => {
			if (!sdkQuery) return;
			void sdkQuery.interrupt().catch(() => {
				try {
					sdkQuery?.close();
				} catch {
					// ignore shutdown errors
				}
			});
		};
		const onAbort = () => {
			wasAborted = true;
			requestAbort();
		};
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const blocks = output.content as Array<
			| { type: "text"; text: string; index: number }
			| { type: "thinking"; thinking: string; thinkingSignature?: string; index: number }
			| {
				type: "toolCall";
				id: string;
				name: string;
				arguments: Record<string, unknown>;
				partialJson: string;
				index: number;
			}
		>;

		let started = false;
		let sawStreamEvent = false;
		let sawToolCall = false;
		let shouldStopEarly = false;

		try {
			const { sdkTools, customTools, customToolNameToSdk, customToolNameToPi } = resolveSdkTools(context);
			const sessionKey = getSessionKeyFromStreamOptions(options);
			if (sessionKey) {
				reconcileToolWatchStateWithContext(sessionKey, context);
			}
			const toolWatchNote = buildToolWatchPromptNote(sessionKey, context, customToolNameToSdk);
			const promptBlocks = buildPromptBlocks(context, customToolNameToSdk, toolWatchNote);
			const prompt = buildPromptStream(promptBlocks);

			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();

			const mcpServers = buildCustomToolServers(customTools);
			const providerSettings = loadProviderSettings();
			const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
			const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
			const skillsAppend = appendSystemPrompt ? extractSkillsAppend(context.systemPrompt) : undefined;
			const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
			const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			const allowSkillAliasRewrite = Boolean(skillsAppend);

			const settingSources: SettingSource[] | undefined = appendSystemPrompt
				? undefined
				: providerSettings.settingSources ?? ["user", "project"];

			// Claude Code will auto-load MCP servers from ~/.claude.json and .mcp.json when settingSources is enabled.
			// In this provider, Claude Code tool execution is denied and pi executes tools instead, so auto-loaded MCP
			// tools are pure token overhead. Pass --strict-mcp-config to ignore all MCP configs except those explicitly
			// provided via the SDK (mcpServers option).
			const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;
			const extraArgs = strictMcpConfigEnabled ? { "strict-mcp-config": null } : undefined;

			const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
				cwd,
				model: model.id,
				tools: sdkTools,
				permissionMode: "dontAsk",
				includePartialMessages: true,
				canUseTool: async () => ({
					behavior: "deny",
					message: TOOL_EXECUTION_DENIED_MESSAGE,
				}),
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					...(systemPromptAppend ? { append: systemPromptAppend } : {}),
				},
				...(settingSources ? { settingSources } : {}),
				...(extraArgs ? { extraArgs } : {}),
				...(mcpServers ? { mcpServers } : {}),
			};

			featureRuntime.runBeforeQuery({
				model,
				context,
				options,
				queryOptions,
			});

			const maxThinkingTokens = mapThinkingTokens(options?.reasoning, model.id, options?.thinkingBudgets);
			if (maxThinkingTokens != null) {
				queryOptions.maxThinkingTokens = maxThinkingTokens;
			}

			sdkQuery = query({
				prompt,
				options: queryOptions,
			});

			if (wasAborted) {
				requestAbort();
			}

			for await (const message of sdkQuery) {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}

				featureRuntime.emitStreamEvent({
					model,
					context,
					options,
					message,
				});

				switch (message.type) {
					case "stream_event": {
						sawStreamEvent = true;
						const event = (message as SDKMessage & { event: any }).event;

						if (event?.type === "message_start") {
							const usage = event.message?.usage;
							output.usage.input = usage?.input_tokens ?? 0;
							output.usage.output = usage?.output_tokens ?? 0;
							output.usage.cacheRead = usage?.cache_read_input_tokens ?? 0;
							output.usage.cacheWrite = usage?.cache_creation_input_tokens ?? 0;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "content_block_start") {
							if (event.content_block?.type === "text") {
								const block = { type: "text", text: "", index: event.index } as const;
								output.content.push(block);
								stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							} else if (event.content_block?.type === "thinking") {
								const block = { type: "thinking", thinking: "", thinkingSignature: "", index: event.index } as const;
								output.content.push(block);
								stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
							} else if (event.content_block?.type === "tool_use") {
								sawToolCall = true;
								const block = {
									type: "toolCall",
									id: event.content_block.id,
									name: mapSdkToolNameToPi(event.content_block.name, customToolNameToPi),
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "",
									index: event.index,
								} as const;
								output.content.push(block);
								stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
							}
							break;
						}

						if (event?.type === "content_block_delta") {
							if (event.delta?.type === "text_delta") {
								const index = blocks.findIndex((block) => block.index === event.index);
								const block = blocks[index];
								if (block?.type === "text") {
									block.text += event.delta.text;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: event.delta.text,
										partial: output,
									});
								}
							} else if (event.delta?.type === "thinking_delta") {
								const index = blocks.findIndex((block) => block.index === event.index);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinking += event.delta.thinking;
									stream.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: event.delta.thinking,
										partial: output,
									});
								}
							} else if (event.delta?.type === "input_json_delta") {
								const index = blocks.findIndex((block) => block.index === event.index);
								const block = blocks[index];
								if (block?.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parsePartialJson(block.partialJson, block.arguments);
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: event.delta.partial_json,
										partial: output,
									});
								}
							} else if (event.delta?.type === "signature_delta") {
								const index = blocks.findIndex((block) => block.index === event.index);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
								}
							}
							break;
						}

						if (event?.type === "content_block_stop") {
							const index = blocks.findIndex((block) => block.index === event.index);
							const block = blocks[index];
							if (!block) break;
							delete (block as any).index;
							if (block.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: index,
									content: block.text,
									partial: output,
								});
							} else if (block.type === "thinking") {
								stream.push({
									type: "thinking_end",
									contentIndex: index,
									content: block.thinking,
									partial: output,
								});
							} else if (block.type === "toolCall") {
								sawToolCall = true;
								block.arguments = mapToolArgs(
									block.name,
									parsePartialJson(block.partialJson, block.arguments),
									allowSkillAliasRewrite,
								);
								delete (block as any).partialJson;
								featureRuntime.emitToolCall({
									toolCallId: block.id,
									toolName: block.name,
									args: block.arguments,
								});
								stream.push({
									type: "toolcall_end",
									contentIndex: index,
									toolCall: block,
									partial: output,
								});
							}
							break;
						}

						if (event?.type === "message_delta") {
							output.stopReason = mapStopReason(event.delta?.stop_reason);
							const usage = event.usage ?? {};
							if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
							if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
							if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
							if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "message_stop" && sawToolCall) {
							output.stopReason = "toolUse";
							shouldStopEarly = true;
							break;
						}

						break;
					}

					case "result": {
						if (!sawStreamEvent && message.subtype === "success") {
							output.content.push({ type: "text", text: message.result || "" });
						}
						break;
					}
				}

				if (shouldStopEarly) {
					break;
				}
			}

			if (wasAborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Operation aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}

			stream.push({
				type: "done",
				reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			const providerError = toProviderError(error, "stream_error");
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = `[${providerError.code}] ${providerError.message}`;
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		} finally {
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			sdkQuery?.close();
		}
		})();

		return stream;
	};
}

export type ClaudeAgentSdkProviderOptions = {
	features?: ReadonlyArray<ClaudeAgentSdkFeature>;
};

export function createProvider(options: ClaudeAgentSdkProviderOptions = {}) {
	const featureRuntime = createFeatureRuntime(options.features ?? []);

	return function registerProvider(pi: ExtensionAPI) {
		extensionApi = pi;
		featureRuntime.register(pi);
		const streamSimple = createStreamClaudeAgentSdk(featureRuntime);

	const refreshToolWatchState = (
		ctx: {
			sessionManager?: { getSessionId?: () => string; getBranch?: () => Array<Record<string, any>> } | undefined;
			model?: { provider?: string } | undefined;
		},
		providerOverride?: string,
	) => {
		const sessionKey = getSessionKeyFromContext(ctx);
		if (!sessionKey) return;
		activeSessionKey = sessionKey;
		const provider = providerOverride ?? ctx.model?.provider;
		if (provider !== PROVIDER_ID) {
			toolWatchStateBySession.delete(sessionKey);
			return;
		}
		const entries = ctx.sessionManager?.getBranch?.() ?? [];
		hydrateToolWatchStateFromEntries(sessionKey, entries);
	};

	pi.on("session_start", (_event, ctx) => {
		refreshToolWatchState(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		refreshToolWatchState(ctx);
	});

	pi.on("session_fork", (_event, ctx) => {
		refreshToolWatchState(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const provider = (event as { model?: { provider?: string } }).model?.provider;
		if (provider !== PROVIDER_ID) return;
		refreshToolWatchState(ctx, provider);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionKey = getSessionKeyFromContext(ctx);
		if (!sessionKey) return;
		toolWatchStateBySession.delete(sessionKey);
		if (activeSessionKey === sessionKey) {
			activeSessionKey = undefined;
		}
	});

	const registerLooseEvent = (
		eventName: string,
		handler: (event: Record<string, unknown>, ctx: Record<string, any>) => void,
	) => {
		const on = pi.on as unknown as (
			event: string,
			handler: (event: Record<string, unknown>, ctx: Record<string, any>) => void,
		) => void;
		on(eventName, handler);
	};

	registerLooseEvent("message_end", (event, ctx) => {
		const provider = ctx?.model?.provider;
		if (provider !== PROVIDER_ID) return;
		const sessionKey = getSessionKeyFromContext(ctx);
		if (!sessionKey) return;
		activeSessionKey = sessionKey;

		const message = (event as { message?: unknown }).message;
		if (!message || typeof message !== "object") return;
		const role = (message as { role?: string }).role;
		const timestampValue = (message as { timestamp?: unknown }).timestamp;
		const timestamp = typeof timestampValue === "number" ? timestampValue : Date.now();

		if (role === "assistant") {
			for (const toolCall of collectAssistantToolCalls(message)) {
				trackPendingToolCall(sessionKey, toolCall.id, toolCall.name, timestamp);
			}
			return;
		}

		if (role === "toolResult") {
			const toolResult = message as {
				toolCallId?: string;
				toolName?: string;
				content?: unknown;
				isError?: boolean;
			};
			if (!toolResult.toolCallId || !toolResult.toolName) return;
			const content = truncateText(contentToPlainText(toolResult.content), MAX_TRACKED_TOOL_CONTENT_CHARS);
			const isError = toolResult.isError === true;
			trackCompletedToolCall(sessionKey, {
				toolCallId: toolResult.toolCallId,
				toolName: toolResult.toolName,
				content,
				isError,
				timestamp,
			});
			try {
				featureRuntime.emitToolResult({
					toolCallId: toolResult.toolCallId,
					toolName: toolResult.toolName,
					result: content,
					isError,
					timestamp,
				});
			} catch (error) {
				const providerError = reportFeatureError(error);
				extensionApi?.appendEntry("claude-agent-sdk-feature-error", {
					code: providerError.code,
					message: providerError.message,
					details: providerError.details,
				});
			}
		}
	});

	registerLooseEvent("tool_execution_start", (event, ctx) => {
		const provider = ctx?.model?.provider;
		if (provider !== PROVIDER_ID) return;
		const sessionKey = getSessionKeyFromContext(ctx);
		if (!sessionKey) return;
		activeSessionKey = sessionKey;

		const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
		const toolName = (event as { toolName?: unknown }).toolName;
		if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
		trackPendingToolCall(sessionKey, toolCallId, toolName, Date.now());
	});

	registerLooseEvent("tool_execution_end", (event, ctx) => {
		const provider = ctx?.model?.provider;
		if (provider !== PROVIDER_ID) return;
		const sessionKey = getSessionKeyFromContext(ctx);
		if (!sessionKey) return;
		activeSessionKey = sessionKey;

		const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
		const toolName = (event as { toolName?: unknown }).toolName;
		if (typeof toolCallId !== "string" || typeof toolName !== "string") return;

		const timestamp = Date.now();
		const content = extractToolExecutionContent((event as { result?: unknown }).result);
		const isError = (event as { isError?: unknown }).isError === true;

		trackCompletedToolCall(sessionKey, {
			toolCallId,
			toolName,
			content,
			isError,
			timestamp,
		});

		try {
			featureRuntime.emitToolResult({
				toolCallId,
				toolName,
				result: content,
				isError,
				timestamp,
			});
		} catch (error) {
			const providerError = reportFeatureError(error);
			extensionApi?.appendEntry("claude-agent-sdk-feature-error", {
				code: providerError.code,
				message: providerError.message,
				details: providerError.details,
			});
		}

		extensionApi?.appendEntry<ToolWatchCustomEntryData>(TOOL_WATCH_CUSTOM_TYPE, {
			type: "tool_execution_end",
			toolCallId,
			toolName,
			content,
			isError,
			timestamp,
		});
	});

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-agent-sdk",
		apiKey: "ANTHROPIC_API_KEY",
		api: "claude-agent-sdk",
		models: MODELS,
		streamSimple,
	});
	};
}

export default createProvider();
