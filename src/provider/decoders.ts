import { Effect, Either, Schema } from "effect";
import { type ClaudeAgentSdkProviderError, toProviderError } from "../core/errors.js";

const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

const StreamEventEnvelopeSchema = Schema.Struct({
	type: Schema.Literal("stream_event"),
	event: UnknownRecordSchema,
});

type UnknownRecord = Record<string, unknown>;

export type DecodedUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

export type DecodedContentBlockStart =
	| { type: "text" }
	| { type: "thinking" }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "unknown"; rawType: string };

export type DecodedContentBlockDelta =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "input_json_delta"; partial_json: string }
	| { type: "signature_delta"; signature: string }
	| { type: "unknown"; rawType: string };

export type DecodedSdkStreamEventMessage =
	| { type: "message_start"; usage: DecodedUsage }
	| { type: "content_block_start"; index: number; contentBlock: DecodedContentBlockStart }
	| { type: "content_block_delta"; index: number; delta: DecodedContentBlockDelta }
	| { type: "content_block_stop"; index: number }
	| { type: "message_delta"; stopReason?: string; usage: DecodedUsage }
	| { type: "message_stop" }
	| { type: "unknown"; rawType: string; event: Record<string, unknown> };

function decodeWithSchema<A>(
	schema: Schema.Schema<A>,
	value: unknown,
	messageType: string,
): Effect.Effect<A, ClaudeAgentSdkProviderError> {
	const decoded = Schema.decodeUnknownEither(schema)(value);
	if (Either.isLeft(decoded)) {
		return Effect.fail(toProviderError(decoded.left, "invalid_sdk_event", { messageType }));
	}
	return Effect.succeed(decoded.right);
}

function decodeRecord(
	value: unknown,
	messageType: string,
): Effect.Effect<UnknownRecord, ClaudeAgentSdkProviderError> {
	return decodeWithSchema(UnknownRecordSchema, value, messageType);
}

function failInvalidEvent(messageType: string, message: string): Effect.Effect<never, ClaudeAgentSdkProviderError> {
	return Effect.fail(toProviderError(new Error(message), "invalid_sdk_event", { messageType }));
}

function decodeRequiredString(
	record: UnknownRecord,
	key: string,
	messageType: string,
): Effect.Effect<string, ClaudeAgentSdkProviderError> {
	const value = record[key];
	if (typeof value === "string") return Effect.succeed(value);
	return failInvalidEvent(messageType, `Expected string at ${key}`);
}

function decodeRequiredNumber(
	record: UnknownRecord,
	key: string,
	messageType: string,
): Effect.Effect<number, ClaudeAgentSdkProviderError> {
	const value = record[key];
	if (typeof value === "number" && Number.isFinite(value)) return Effect.succeed(value);
	return failInvalidEvent(messageType, `Expected finite number at ${key}`);
}

function decodeOptionalString(
	record: UnknownRecord,
	key: string,
	messageType: string,
): Effect.Effect<string | undefined, ClaudeAgentSdkProviderError> {
	const value = record[key];
	if (value == null) return Effect.succeed(undefined);
	if (typeof value === "string") return Effect.succeed(value);
	return failInvalidEvent(messageType, `Expected string at ${key}`);
}

function decodeOptionalNumber(
	record: UnknownRecord,
	key: string,
	messageType: string,
): Effect.Effect<number | undefined, ClaudeAgentSdkProviderError> {
	const value = record[key];
	if (value == null) return Effect.succeed(undefined);
	if (typeof value === "number" && Number.isFinite(value)) return Effect.succeed(value);
	return failInvalidEvent(messageType, `Expected finite number at ${key}`);
}

function decodeUsage(
	value: unknown,
	messageType: string,
): Effect.Effect<DecodedUsage, ClaudeAgentSdkProviderError> {
	if (value == null) return Effect.succeed({});
	return Effect.gen(function* () {
		const usage = yield* decodeRecord(value, messageType);
		const input_tokens = yield* decodeOptionalNumber(usage, "input_tokens", messageType);
		const output_tokens = yield* decodeOptionalNumber(usage, "output_tokens", messageType);
		const cache_read_input_tokens = yield* decodeOptionalNumber(usage, "cache_read_input_tokens", messageType);
		const cache_creation_input_tokens = yield* decodeOptionalNumber(
			usage,
			"cache_creation_input_tokens",
			messageType,
		);
		return {
			...(input_tokens == null ? {} : { input_tokens }),
			...(output_tokens == null ? {} : { output_tokens }),
			...(cache_read_input_tokens == null ? {} : { cache_read_input_tokens }),
			...(cache_creation_input_tokens == null ? {} : { cache_creation_input_tokens }),
		};
	});
}

function decodeMessageStartEvent(event: UnknownRecord): Effect.Effect<DecodedSdkStreamEventMessage, ClaudeAgentSdkProviderError> {
	return Effect.gen(function* () {
		const messageType = "stream_event.message_start";
		const message = event.message == null ? undefined : yield* decodeRecord(event.message, `${messageType}.message`);
		const usage = yield* decodeUsage(message?.usage, `${messageType}.usage`);
		return { type: "message_start", usage } as const;
	});
}

function decodeContentBlockStartEvent(
	event: UnknownRecord,
): Effect.Effect<DecodedSdkStreamEventMessage, ClaudeAgentSdkProviderError> {
	return Effect.gen(function* () {
		const messageType = "stream_event.content_block_start";
		const index = yield* decodeRequiredNumber(event, "index", messageType);
		const contentBlockRecord = yield* decodeRecord(event.content_block, `${messageType}.content_block`);
		const contentBlockType = yield* decodeRequiredString(contentBlockRecord, "type", `${messageType}.content_block.type`);

		if (contentBlockType === "text") {
			return { type: "content_block_start", index, contentBlock: { type: "text" } } as const;
		}
		if (contentBlockType === "thinking") {
			return { type: "content_block_start", index, contentBlock: { type: "thinking" } } as const;
		}
		if (contentBlockType === "tool_use") {
			const id = yield* decodeRequiredString(contentBlockRecord, "id", `${messageType}.content_block.id`);
			const name = yield* decodeRequiredString(contentBlockRecord, "name", `${messageType}.content_block.name`);
			const inputValue = contentBlockRecord.input;
			const input = inputValue == null ? {} : yield* decodeRecord(inputValue, `${messageType}.content_block.input`);
			return {
				type: "content_block_start",
				index,
				contentBlock: {
					type: "tool_use",
					id,
					name,
					input,
				},
			} as const;
		}
		return {
			type: "content_block_start",
			index,
			contentBlock: {
				type: "unknown",
				rawType: contentBlockType,
			},
		} as const;
	});
}

function decodeContentBlockDeltaEvent(
	event: UnknownRecord,
): Effect.Effect<DecodedSdkStreamEventMessage, ClaudeAgentSdkProviderError> {
	return Effect.gen(function* () {
		const messageType = "stream_event.content_block_delta";
		const index = yield* decodeRequiredNumber(event, "index", messageType);
		const deltaRecord = yield* decodeRecord(event.delta, `${messageType}.delta`);
		const deltaType = yield* decodeRequiredString(deltaRecord, "type", `${messageType}.delta.type`);

		if (deltaType === "text_delta") {
			const text = yield* decodeRequiredString(deltaRecord, "text", `${messageType}.delta.text`);
			return { type: "content_block_delta", index, delta: { type: "text_delta", text } } as const;
		}
		if (deltaType === "thinking_delta") {
			const thinking = yield* decodeRequiredString(deltaRecord, "thinking", `${messageType}.delta.thinking`);
			return { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } } as const;
		}
		if (deltaType === "input_json_delta") {
			const partial_json = yield* decodeRequiredString(deltaRecord, "partial_json", `${messageType}.delta.partial_json`);
			return { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } } as const;
		}
		if (deltaType === "signature_delta") {
			const signature = yield* decodeRequiredString(deltaRecord, "signature", `${messageType}.delta.signature`);
			return { type: "content_block_delta", index, delta: { type: "signature_delta", signature } } as const;
		}
		return {
			type: "content_block_delta",
			index,
			delta: {
				type: "unknown",
				rawType: deltaType,
			},
		} as const;
	});
}

function decodeContentBlockStopEvent(
	event: UnknownRecord,
): Effect.Effect<DecodedSdkStreamEventMessage, ClaudeAgentSdkProviderError> {
	return Effect.map(decodeRequiredNumber(event, "index", "stream_event.content_block_stop"), (index) => ({
		type: "content_block_stop",
		index,
	} as const));
}

function decodeMessageDeltaEvent(event: UnknownRecord): Effect.Effect<DecodedSdkStreamEventMessage, ClaudeAgentSdkProviderError> {
	return Effect.gen(function* () {
		const messageType = "stream_event.message_delta";
		const deltaValue = event.delta;
		const delta = deltaValue == null ? undefined : yield* decodeRecord(deltaValue, `${messageType}.delta`);
		const usage = yield* decodeUsage(event.usage, `${messageType}.usage`);
		const stopReason = delta ? yield* decodeOptionalString(delta, "stop_reason", `${messageType}.delta.stop_reason`) : undefined;
		return {
			type: "message_delta",
			...(stopReason == null ? {} : { stopReason }),
			usage,
		} as const;
	});
}

export function decodeSdkStreamEventMessage(
	message: unknown,
): Effect.Effect<DecodedSdkStreamEventMessage, ClaudeAgentSdkProviderError> {
	return Effect.gen(function* () {
		const envelope = yield* decodeWithSchema(StreamEventEnvelopeSchema, message, "stream_event");

		const eventType = yield* decodeRequiredString(envelope.event, "type", "stream_event.type");
		switch (eventType) {
			case "message_start":
				return yield* decodeMessageStartEvent(envelope.event);
			case "content_block_start":
				return yield* decodeContentBlockStartEvent(envelope.event);
			case "content_block_delta":
				return yield* decodeContentBlockDeltaEvent(envelope.event);
			case "content_block_stop":
				return yield* decodeContentBlockStopEvent(envelope.event);
			case "message_delta":
				return yield* decodeMessageDeltaEvent(envelope.event);
			case "message_stop":
				return { type: "message_stop" } as const;
			default:
				return {
					type: "unknown",
					rawType: eventType,
					event: envelope.event,
				} as const;
		}
	});
}

export function decodeSdkStreamEventMessageSync(message: unknown): DecodedSdkStreamEventMessage {
	const result = Effect.runSync(Effect.either(decodeSdkStreamEventMessage(message)));
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}
