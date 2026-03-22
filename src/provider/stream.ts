import { query } from "@anthropic-ai/claude-agent-sdk";
import type { createSdkMcpServer, SDKMessage, SDKUserMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import type { ProviderSettings } from "../config/providerSettings.js";
import { toProviderError } from "../core/errors.js";
import type { ClaudeQueryOptions, FeatureRuntime } from "../core/features.js";
import { mapToolArgs } from "../mapping/toolArgs.js";
import { decodeSdkStreamEventMessageSync } from "./decoders.js";
import { dispatchStreamContentEvent, type StreamDispatchEmission } from "./stream.dispatch.js";
import type { StreamBlock } from "./stream.ctx.js";
import { mapThinkingTokens } from "./stream.opts.js";
import { applyMessageDeltaUsage, applyMessageStartUsage, applyMessageStopReason, toDoneReason } from "./stream.stop.js";

export type SdkQueryLike = AsyncIterable<SDKMessage> & {
	interrupt(): Promise<void>;
	close(): void;
};

export type QueryFn = (params: {
	prompt: string | AsyncIterable<SDKUserMessage>;
	options?: ClaudeQueryOptions;
}) => SdkQueryLike;

type SdkToolsResolution = {
	sdkTools: string[];
	customTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
};

export type StreamEngineDeps = {
	queryFn?: QueryFn;
	resolveSdkTools: (context: Context) => SdkToolsResolution;
	mapSdkToolNameToPi: (toolName: string, customToolNameToPi?: Map<string, string>) => string;
	getSessionKeyFromStreamOptions: (options?: SimpleStreamOptions) => string | undefined;
	reconcileToolWatchStateWithContext: (sessionKey: string, context: Context) => void;
	buildToolWatchPromptNote: (
		sessionKey: string | undefined,
		context: Context,
		customToolNameToSdk?: Map<string, string>,
	) => string | undefined;
	buildPromptBlocks: (
		context: Context,
		customToolNameToSdk: Map<string, string> | undefined,
		toolWatchNote?: string,
	) => ContentBlockParam[];
	buildPromptStream: (promptBlocks: ContentBlockParam[]) => AsyncIterable<SDKUserMessage>;
	buildCustomToolServers: (
		customTools: Tool[],
	) => Record<string, ReturnType<typeof createSdkMcpServer>> | undefined;
	getProviderSettings: () => ProviderSettings;
	extractAgentsAppend: () => string | undefined;
	extractSkillsAppend: (systemPrompt?: string) => string | undefined;
	toolExecutionDeniedMessage: string;
};

type StreamRuntimeOptions = SimpleStreamOptions & { cwd?: string };

export function createStreamClaudeAgentSdk(featureRuntime: FeatureRuntime, deps: StreamEngineDeps) {
	const queryFn: QueryFn = deps.queryFn ?? query;

	return function streamClaudeAgentSdk(
		model: Model<Api>,
		context: Context,
		options?: StreamRuntimeOptions,
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

			let sdkQuery: SdkQueryLike | undefined;
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

			const blocks: StreamBlock[] = [];
			output.content = blocks;
			let started = false;
			let sawStreamEvent = false;
			let sawToolCall = false;
			let shouldStopEarly = false;

			const emitDispatchEvents = (events: StreamDispatchEmission[]) => {
				for (const item of events) {
					switch (item.type) {
						case "text_start":
							stream.push({ type: "text_start", contentIndex: item.contentIndex, partial: output });
							break;
						case "text_delta":
							stream.push({ type: "text_delta", contentIndex: item.contentIndex, delta: item.delta, partial: output });
							break;
						case "text_end":
							stream.push({ type: "text_end", contentIndex: item.contentIndex, content: item.content, partial: output });
							break;
						case "thinking_start":
							stream.push({ type: "thinking_start", contentIndex: item.contentIndex, partial: output });
							break;
						case "thinking_delta":
							stream.push({ type: "thinking_delta", contentIndex: item.contentIndex, delta: item.delta, partial: output });
							break;
						case "thinking_end":
							stream.push({ type: "thinking_end", contentIndex: item.contentIndex, content: item.content, partial: output });
							break;
						case "toolcall_start":
							sawToolCall = true;
							stream.push({ type: "toolcall_start", contentIndex: item.contentIndex, partial: output });
							break;
						case "toolcall_delta":
							stream.push({ type: "toolcall_delta", contentIndex: item.contentIndex, delta: item.delta, partial: output });
							break;
						case "toolcall_end":
							sawToolCall = true;
							featureRuntime.emitToolCall({
								toolCallId: item.toolCall.id,
								toolName: item.toolCall.name,
								args: item.toolCall.arguments,
							});
							stream.push({ type: "toolcall_end", contentIndex: item.contentIndex, toolCall: item.toolCall, partial: output });
							break;
					}
				}
			};

			try {
				const { sdkTools, customTools, customToolNameToSdk, customToolNameToPi } = deps.resolveSdkTools(context);
				const sessionKey = deps.getSessionKeyFromStreamOptions(options);
				if (sessionKey) deps.reconcileToolWatchStateWithContext(sessionKey, context);

				const toolWatchNote = deps.buildToolWatchPromptNote(sessionKey, context, customToolNameToSdk);
				const promptBlocks = deps.buildPromptBlocks(context, customToolNameToSdk, toolWatchNote);
				const prompt = deps.buildPromptStream(promptBlocks);
				const cwd = options?.cwd ?? process.cwd();

				const mcpServers = deps.buildCustomToolServers(customTools);
				const providerSettings = deps.getProviderSettings();
				const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
				const agentsAppend = appendSystemPrompt ? deps.extractAgentsAppend() : undefined;
				const skillsAppend = appendSystemPrompt ? deps.extractSkillsAppend(context.systemPrompt) : undefined;
				const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
				const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
				const allowSkillAliasRewrite = Boolean(skillsAppend);

				const settingSources: SettingSource[] | undefined = appendSystemPrompt
					? undefined
					: providerSettings.settingSources ?? ["user", "project"];
				const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;
				const extraArgs = strictMcpConfigEnabled ? { "strict-mcp-config": null } : undefined;

				const queryOptions: ClaudeQueryOptions = {
					cwd,
					model: model.id,
					tools: sdkTools,
					permissionMode: "dontAsk",
					includePartialMessages: true,
					canUseTool: async () => ({ behavior: "deny", message: deps.toolExecutionDeniedMessage }),
					systemPrompt: {
						type: "preset",
						preset: "claude_code",
						...(systemPromptAppend ? { append: systemPromptAppend } : {}),
					},
					...(settingSources ? { settingSources } : {}),
					...(extraArgs ? { extraArgs } : {}),
					...(mcpServers ? { mcpServers } : {}),
				};

				featureRuntime.runBeforeQuery({ model, context, options, queryOptions });
				const maxThinkingTokens = mapThinkingTokens(options?.reasoning, model.id, options?.thinkingBudgets);
				if (maxThinkingTokens != null) queryOptions.maxThinkingTokens = maxThinkingTokens;

				sdkQuery = queryFn({ prompt, options: queryOptions });
				if (wasAborted) requestAbort();

				for await (const message of sdkQuery) {
					if (!started) {
						stream.push({ type: "start", partial: output });
						started = true;
					}

					featureRuntime.emitStreamEvent({ model, context, options, message });

					switch (message.type) {
						case "stream_event": {
							sawStreamEvent = true;
							const event = decodeSdkStreamEventMessageSync(message);

							switch (event.type) {
								case "message_start":
									applyMessageStartUsage(model, output, event);
									break;
								case "content_block_start":
								case "content_block_delta":
								case "content_block_stop": {
									const result = dispatchStreamContentEvent(blocks, event, {
										mapSdkToolNameToPi: (toolName) => deps.mapSdkToolNameToPi(toolName, customToolNameToPi),
										mapToolArgs: (toolName, args) => mapToolArgs(toolName, args, allowSkillAliasRewrite),
									});
									if (result.handled) emitDispatchEvents(result.emissions);
									break;
								}
								case "message_delta":
									applyMessageDeltaUsage(model, output, event);
									break;
								case "message_stop":
									shouldStopEarly = applyMessageStopReason(output, sawToolCall);
									break;
								case "unknown":
								default:
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

					if (shouldStopEarly) break;
				}

				if (wasAborted || options?.signal?.aborted) {
					output.stopReason = "aborted";
					output.errorMessage = "Operation aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
					stream.end();
					return;
				}

				stream.push({ type: "done", reason: toDoneReason(output.stopReason), message: output });
				stream.end();
			} catch (error) {
				const providerError = toProviderError(error, "stream_error");
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = `[${providerError.code}] ${providerError.message}`;
				const reason = output.stopReason === "aborted" ? "aborted" : "error";
				stream.push({ type: "error", reason, error: output });
				stream.end();
			} finally {
				if (options?.signal) options.signal.removeEventListener("abort", onAbort);
				sdkQuery?.close();
			}
		})();

		return stream;
	};
}
