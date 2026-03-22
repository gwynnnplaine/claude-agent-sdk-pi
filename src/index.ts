import { createSdkMcpServer, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { getModels, type Context, type ImageContent, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { loadProviderSettings } from "./config/providerSettings.js";
import { GLOBAL_AGENTS_PATH, GLOBAL_SKILLS_ROOT, MCP_SERVER_NAME, MCP_TOOL_PREFIX, PROJECT_SKILLS_ROOT, PROVIDER_ID, SKILLS_ALIAS_GLOBAL, SKILLS_ALIAS_PROJECT, TOOL_EXECUTION_DENIED_MESSAGE } from "./core/constants.js";
import { createFeatureRuntime, reportFeatureError, type ClaudeAgentSdkFeature } from "./core/features.js";
import {
	decodeLooseContext,
	decodeMessageEndEvent,
	decodeModelSelectProvider,
	decodeToolExecutionEndEvent,
	decodeToolExecutionStartEvent,
	decodeToolResultMessage,
} from "./decoders/index.events.js";
import { BUILTIN_TOOL_NAMES, DEFAULT_TOOLS, PI_TO_SDK_TOOL_NAME, mapPiToolNameToSdk, mapSdkToolNameToPi } from "./mapping/toolNames.js";
import { createStreamClaudeAgentSdk } from "./provider/stream.js";
import { ToolWatchStore } from "./provider/toolWatch.js";

const TOOL_WATCH_CUSTOM_TYPE = "claude-agent-sdk-tool-watch";
const MAX_TRACKED_TOOL_CONTENT_CHARS = 4000;

type ToolWatchCustomEntryData = {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type TrackedToolExecution = {
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

const toolWatchStore = new ToolWatchStore();
let activeSessionKey: string | undefined;
let extensionApi: ExtensionAPI | undefined;

function getSessionKeyFromSessionId(sessionId?: string): string | undefined {
	return toolWatchStore.getSessionKeyFromSessionId(sessionId);
}

function getSessionKeyFromStreamOptions(options?: SimpleStreamOptions): string | undefined {
	return toolWatchStore.getSessionKeyFromStreamOptions(options, activeSessionKey);
}

function getSessionKeyFromContext(
	ctx?: { sessionManager?: { getSessionId?: () => string } | undefined } | undefined,
): string | undefined {
	return toolWatchStore.getSessionKeyFromContext(ctx);
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n...[truncated]`;
}

function contentToPlainText(content: unknown): string {
	return toolWatchStore.contentToPlainText(content);
}

function extractToolExecutionContent(result: unknown): string {
	return toolWatchStore.extractToolExecutionContent(result);
}

function collectAssistantToolCalls(message: unknown): Array<{ id: string; name: string }> {
	return toolWatchStore.collectAssistantToolCalls(message);
}

function trackPendingToolCall(sessionKey: string, toolCallId: string, toolName: string, timestamp: number): void {
	toolWatchStore.trackPendingToolCall(sessionKey, toolCallId, toolName, timestamp);
}

function trackCompletedToolCall(sessionKey: string, execution: TrackedToolExecution): void {
	toolWatchStore.trackCompletedToolCall(sessionKey, execution);
}

function hydrateToolWatchStateFromEntries(sessionKey: string, entries: ReadonlyArray<unknown>): void {
	toolWatchStore.hydrateFromEntries(sessionKey, entries);
}

function reconcileToolWatchStateWithContext(sessionKey: string, context: Context): void {
	toolWatchStore.reconcileWithContext(sessionKey, context);
}

function buildToolWatchPromptNote(
	sessionKey: string | undefined,
	context: Context,
	customToolNameToSdk?: Map<string, string>,
): string | undefined {
	return toolWatchStore.buildPromptNote(sessionKey, context, customToolNameToSdk);
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

function toBase64ImageMediaType(mimeType: string): Base64ImageSource["media_type"] | undefined {
	switch (mimeType) {
		case "image/jpeg":
		case "image/png":
		case "image/gif":
		case "image/webp":
			return mimeType;
		default:
			return undefined;
	}
}

function buildPromptBlocks(
	context: Context,
	customToolNameToSdk: Map<string, string> | undefined,
	toolWatchNote?: string,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];

	const pushText = (text: string) => {
		blocks.push({ type: "text", text });
	};

	const pushImage = (data: string, mediaType: Base64ImageSource["media_type"]) => {
		blocks.push({
			type: "image",
			source: {
				type: "base64",
				media_type: mediaType,
				data,
			},
		});
	};

	const pushPrefix = (label: string) => {
		const prefix = `${blocks.length ? "\n\n" : ""}${label}\n`;
		pushText(prefix);
	};

	type PromptContentBlock = {
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	};

	const appendContentBlocks = (content: string | PromptContentBlock[]): boolean => {
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
				if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
					pushText("[image]");
					continue;
				}
				const mediaType = toBase64ImageMediaType(block.mimeType);
				if (!mediaType) {
					pushText(`[image:${block.mimeType}]`);
					continue;
				}
				pushImage(block.data, mediaType);
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
		const messageContent: MessageParam["content"] = promptBlocks;
		const message: SDKUserMessage = {
			type: "user",
			message: {
				role: "user",
				content: messageContent,
			},
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
		inputSchema: tool.parameters,
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

export type ClaudeAgentSdkProviderOptions = {
	features?: ReadonlyArray<ClaudeAgentSdkFeature>;
};

export function createProvider(options: ClaudeAgentSdkProviderOptions = {}) {
	const featureRuntime = createFeatureRuntime(options.features ?? []);

	return function registerProvider(pi: ExtensionAPI) {
		extensionApi = pi;
		featureRuntime.register(pi);
		const streamSimple = createStreamClaudeAgentSdk(featureRuntime, {
			resolveSdkTools,
			mapSdkToolNameToPi,
			getSessionKeyFromStreamOptions,
			reconcileToolWatchStateWithContext,
			buildToolWatchPromptNote,
			buildPromptBlocks,
			buildPromptStream,
			buildCustomToolServers,
			getProviderSettings: loadProviderSettings,
			extractAgentsAppend,
			extractSkillsAppend,
			toolExecutionDeniedMessage: TOOL_EXECUTION_DENIED_MESSAGE,
		});

	const refreshToolWatchState = (
		ctx: {
			sessionManager?: { getSessionId?: () => string; getBranch?: () => ReadonlyArray<unknown> } | undefined;
			model?: { provider?: string } | undefined;
		},
		providerOverride?: string,
	) => {
		const sessionKey = getSessionKeyFromContext(ctx);
		if (!sessionKey) return;
		activeSessionKey = sessionKey;
		const provider = providerOverride ?? ctx.model?.provider;
		if (provider !== PROVIDER_ID) {
			toolWatchStore.deleteSession(sessionKey);
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
		const provider = decodeModelSelectProvider(event);
		if (provider !== PROVIDER_ID) return;
		refreshToolWatchState(ctx, provider);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionKey = getSessionKeyFromContext(ctx);
		if (!sessionKey) return;
		toolWatchStore.deleteSession(sessionKey);
		if (activeSessionKey === sessionKey) {
			activeSessionKey = undefined;
		}
	});

	pi.on("message_end", (event, ctx) => {
		const context = decodeLooseContext(ctx);
		const provider = context.modelProvider;
		if (provider !== PROVIDER_ID) return;
		const sessionKey = getSessionKeyFromContext({ sessionManager: context.sessionManager });
		if (!sessionKey) return;
		activeSessionKey = sessionKey;

		const messageEvent = decodeMessageEndEvent(event);
		if (!messageEvent) return;
		const timestamp = messageEvent.timestamp ?? Date.now();

		if (messageEvent.role === "assistant") {
			for (const toolCall of collectAssistantToolCalls(messageEvent.message)) {
				trackPendingToolCall(sessionKey, toolCall.id, toolCall.name, timestamp);
			}
			return;
		}

		if (messageEvent.role === "toolResult") {
			const toolResult = decodeToolResultMessage(messageEvent.message);
			if (!toolResult) return;
			const content = truncateText(contentToPlainText(toolResult.content), MAX_TRACKED_TOOL_CONTENT_CHARS);
			trackCompletedToolCall(sessionKey, {
				toolCallId: toolResult.toolCallId,
				toolName: toolResult.toolName,
				content,
				isError: toolResult.isError,
				timestamp,
			});
			try {
				featureRuntime.emitToolResult({
					toolCallId: toolResult.toolCallId,
					toolName: toolResult.toolName,
					result: content,
					isError: toolResult.isError,
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

	pi.on("tool_execution_start", (event, ctx) => {
		const context = decodeLooseContext(ctx);
		const provider = context.modelProvider;
		if (provider !== PROVIDER_ID) return;
		const sessionKey = getSessionKeyFromContext({ sessionManager: context.sessionManager });
		if (!sessionKey) return;
		activeSessionKey = sessionKey;

		const toolExecutionStart = decodeToolExecutionStartEvent(event);
		if (!toolExecutionStart) return;
		trackPendingToolCall(sessionKey, toolExecutionStart.toolCallId, toolExecutionStart.toolName, Date.now());
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const context = decodeLooseContext(ctx);
		const provider = context.modelProvider;
		if (provider !== PROVIDER_ID) return;
		const sessionKey = getSessionKeyFromContext({ sessionManager: context.sessionManager });
		if (!sessionKey) return;
		activeSessionKey = sessionKey;

		const toolExecutionEnd = decodeToolExecutionEndEvent(event);
		if (!toolExecutionEnd) return;

		const timestamp = Date.now();
		const content = extractToolExecutionContent(toolExecutionEnd.result);
		const isError = toolExecutionEnd.isError;

		trackCompletedToolCall(sessionKey, {
			toolCallId: toolExecutionEnd.toolCallId,
			toolName: toolExecutionEnd.toolName,
			content,
			isError,
			timestamp,
		});

		try {
			featureRuntime.emitToolResult({
				toolCallId: toolExecutionEnd.toolCallId,
				toolName: toolExecutionEnd.toolName,
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
			toolCallId: toolExecutionEnd.toolCallId,
			toolName: toolExecutionEnd.toolName,
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
