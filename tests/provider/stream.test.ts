import test from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
	BetaInputJSONDelta,
	BetaMessageDeltaUsage,
	BetaRawContentBlockDeltaEvent,
	BetaRawContentBlockStartEvent,
	BetaRawContentBlockStopEvent,
	BetaRawMessageDeltaEvent,
	BetaRawMessageStreamEvent,
	BetaTextBlock,
	BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context, Model, Tool } from "@mariozechner/pi-ai";
import { createFeatureRuntime } from "../../src/core/features.js";
import { createStreamClaudeAgentSdk, type StreamEngineDeps, type SdkQueryLike } from "../../src/provider/stream.js";

function createModel(): Model<"claude-agent-sdk"> {
	return {
		id: "claude-sonnet",
		name: "Claude Sonnet",
		api: "claude-agent-sdk",
		provider: "anthropic",
		baseUrl: "claude-agent-sdk",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 4096,
	};
}

function createContext(): Context {
	return {
		messages: [],
	};
}

type StreamEventMessage = Extract<SDKMessage, { type: "stream_event" }>;

function sdkStreamEvent(event: BetaRawMessageStreamEvent): StreamEventMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: "00000000-0000-0000-0000-000000000000",
		session_id: "session-1",
	};
}

function defaultDeltaUsage(): BetaMessageDeltaUsage {
	return {
		cache_creation_input_tokens: null,
		cache_read_input_tokens: null,
		input_tokens: null,
		iterations: null,
		output_tokens: 0,
		server_tool_use: null,
	};
}

function textBlockStart(index: number): BetaRawContentBlockStartEvent {
	const contentBlock: BetaTextBlock = { type: "text", text: "", citations: null };
	return { type: "content_block_start", index, content_block: contentBlock };
}

function toolUseBlockStart(index: number, id: string, name: string): BetaRawContentBlockStartEvent {
	const contentBlock: BetaToolUseBlock = { type: "tool_use", id, name, input: {} };
	return { type: "content_block_start", index, content_block: contentBlock };
}

function textDelta(index: number, text: string): BetaRawContentBlockDeltaEvent {
	return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

function jsonDelta(index: number, partial_json: string): BetaRawContentBlockDeltaEvent {
	const delta: BetaInputJSONDelta = { type: "input_json_delta", partial_json };
	return { type: "content_block_delta", index, delta };
}

function blockStop(index: number): BetaRawContentBlockStopEvent {
	return { type: "content_block_stop", index };
}

function messageDelta(stopReason: "end_turn" | "max_tokens"): BetaRawMessageDeltaEvent {
	return {
		type: "message_delta",
		context_management: null,
		delta: {
			container: null,
			stop_reason: stopReason,
			stop_sequence: null,
		},
		usage: defaultDeltaUsage(),
	};
}

function makeQuery(messages: SDKMessage[]): SdkQueryLike {
	const iterator = (async function* () {
		for (const message of messages) {
			yield message;
		}
	})();
	return Object.assign(iterator, {
		interrupt: async () => {
			// noop
		},
		close: () => {
			// noop
		},
	});
}

function createDeps(messages: SDKMessage[]): StreamEngineDeps {
	const customTools: Tool[] = [];
	const promptBlocks: ContentBlockParam[] = [{ type: "text", text: "" }];
	return {
		queryFn: () => makeQuery(messages),
		resolveSdkTools: () => ({
			sdkTools: [],
			customTools,
			customToolNameToSdk: new Map<string, string>(),
			customToolNameToPi: new Map<string, string>(),
		}),
		mapSdkToolNameToPi: (toolName) => toolName,
		getSessionKeyFromStreamOptions: () => undefined,
		reconcileToolWatchStateWithContext: () => {
			// noop
		},
		buildToolWatchPromptNote: () => undefined,
		buildPromptBlocks: () => promptBlocks,
		buildPromptStream: (_blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> =>
			(async function* () {
				yield {
					type: "user",
					message: { role: "user", content: "" },
					parent_tool_use_id: null,
					session_id: "prompt",
				};
			})(),
		buildCustomToolServers: () => undefined,
		getProviderSettings: () => ({}),
		extractAgentsAppend: () => undefined,
		extractSkillsAppend: () => undefined,
		toolExecutionDeniedMessage: "denied",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getEventType(event: unknown): string {
	if (!isRecord(event)) return "unknown";
	const eventType = event.type;
	return typeof eventType === "string" ? eventType : "unknown";
}

function findEvent(events: unknown[], type: string): Record<string, unknown> | undefined {
	for (const event of events) {
		if (getEventType(event) !== type) continue;
		if (!isRecord(event)) continue;
		return event;
	}
	return undefined;
}

function getDoneReason(event: Record<string, unknown> | undefined): string | undefined {
	if (!event) return undefined;
	const reason = event.reason;
	return typeof reason === "string" ? reason : undefined;
}

function getToolCallArguments(event: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!event) return undefined;
	const toolCall = event.toolCall;
	if (!isRecord(toolCall)) return undefined;
	const argumentsValue = toolCall.arguments;
	return isRecord(argumentsValue) ? argumentsValue : undefined;
}

function getErrorMessage(event: Record<string, unknown> | undefined): string | undefined {
	if (!event) return undefined;
	const errorValue = event.error;
	if (!isRecord(errorValue)) return undefined;
	const errorMessage = errorValue.errorMessage;
	return typeof errorMessage === "string" ? errorMessage : undefined;
}

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

test("stream emits start/text_start/text_delta/text_end/done for text flow", async () => {
	const messages: SDKMessage[] = [
		sdkStreamEvent(textBlockStart(0)),
		sdkStreamEvent(textDelta(0, "hello")),
		sdkStreamEvent(blockStop(0)),
		sdkStreamEvent(messageDelta("end_turn")),
		sdkStreamEvent({ type: "message_stop" }),
	];

	const streamSimple = createStreamClaudeAgentSdk(createFeatureRuntime([]), createDeps(messages));
	const events = await collectEvents(streamSimple(createModel(), createContext(), {}));
	const types = events.map(getEventType);

	assert.deepEqual(types, ["start", "text_start", "text_delta", "text_end", "done"]);
	assert.equal(getDoneReason(findEvent(events, "done")), "stop");
});

test("stream emits tool call events, maps args via mapToolArgs, and finishes with toolUse", async () => {
	const messages: SDKMessage[] = [
		sdkStreamEvent(toolUseBlockStart(0, "tool-1", "Read")),
		sdkStreamEvent(jsonDelta(0, '{"file_path":"/tmp/a.txt","offset":2}')),
		sdkStreamEvent(blockStop(0)),
		sdkStreamEvent({ type: "message_stop" }),
	];

	const streamSimple = createStreamClaudeAgentSdk(createFeatureRuntime([]), createDeps(messages));
	const events = await collectEvents(streamSimple(createModel(), createContext(), {}));
	const types = events.map(getEventType);
	assert.deepEqual(types, ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);

	assert.deepEqual(getToolCallArguments(findEvent(events, "toolcall_end")), {
		path: "/tmp/a.txt",
		offset: 2,
		limit: undefined,
	});
	assert.equal(getDoneReason(findEvent(events, "done")), "toolUse");
});

test("malformed SDK stream event surfaces invalid_sdk_event at stream_error boundary", async () => {
	const messages: SDKMessage[] = [sdkStreamEvent(blockStop(Number.NaN))];

	const streamSimple = createStreamClaudeAgentSdk(createFeatureRuntime([]), createDeps(messages));
	const events = await collectEvents(streamSimple(createModel(), createContext(), {}));
	const types = events.map(getEventType);
	assert.deepEqual(types, ["start", "error"]);
	assert.ok(getErrorMessage(findEvent(events, "error"))?.includes("[invalid_sdk_event]"));
});

test("stop reason mapping keeps max_tokens => length", async () => {
	const messages: SDKMessage[] = [sdkStreamEvent(messageDelta("max_tokens")), sdkStreamEvent({ type: "message_stop" })];

	const streamSimple = createStreamClaudeAgentSdk(createFeatureRuntime([]), createDeps(messages));
	const events = await collectEvents(streamSimple(createModel(), createContext(), {}));
	assert.equal(getDoneReason(findEvent(events, "done")), "length");
});
