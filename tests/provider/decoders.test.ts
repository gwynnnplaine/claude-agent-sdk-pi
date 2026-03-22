import test from "node:test";
import assert from "node:assert/strict";
import { Effect, Either } from "effect";
import { decodeSdkStreamEventMessage } from "../../src/provider/decoders.js";
import { ClaudeAgentSdkProviderError } from "../../src/core/errors.js";

function sdkStreamEvent(event: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: "00000000-0000-0000-0000-000000000000",
		session_id: "session-1",
	};
}

test("decodeSdkStreamEventMessage decodes message_start usage", () => {
	const input = sdkStreamEvent({
		type: "message_start",
		message: {
			usage: {
				input_tokens: 1,
				output_tokens: 2,
				cache_read_input_tokens: 3,
				cache_creation_input_tokens: 4,
			},
		},
	});

	const decoded = Effect.runSync(decodeSdkStreamEventMessage(input));

	assert.equal(decoded.type, "message_start");
	assert.deepEqual(decoded.usage, {
		input_tokens: 1,
		output_tokens: 2,
		cache_read_input_tokens: 3,
		cache_creation_input_tokens: 4,
	});
});

test("decodeSdkStreamEventMessage decodes tool_use block start", () => {
	const input = sdkStreamEvent({
		type: "content_block_start",
		index: 3,
		content_block: {
			type: "tool_use",
			id: "tool-1",
			name: "Read",
			input: { path: "a" },
		},
	});

	const decoded = Effect.runSync(decodeSdkStreamEventMessage(input));

	assert.deepEqual(decoded, {
		type: "content_block_start",
		index: 3,
		contentBlock: {
			type: "tool_use",
			id: "tool-1",
			name: "Read",
			input: { path: "a" },
		},
	});
});

test("decodeSdkStreamEventMessage fails with typed error on malformed known event", () => {
	const malformed = sdkStreamEvent({
		type: "content_block_stop",
		index: Number.NaN,
	});

	const decoded = Effect.runSync(Effect.either(decodeSdkStreamEventMessage(malformed)));

	assert.ok(Either.isLeft(decoded));
	const error = decoded.left;
	assert.ok(error instanceof ClaudeAgentSdkProviderError);
	assert.equal(error.code, "invalid_sdk_event");
});
