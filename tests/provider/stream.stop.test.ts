import test from "node:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { applyMessageDeltaUsage, applyMessageStopReason, toDoneReason } from "../../src/provider/stream.stop.js";

function createModel(): Model<Api> {
	return {
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	};
}

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

test("applyMessageDeltaUsage maps max_tokens => length", () => {
	const output = createOutput();
	applyMessageDeltaUsage(createModel(), output, {
		type: "message_delta",
		stopReason: "max_tokens",
		usage: { output_tokens: 12 },
	});
	assert.equal(output.stopReason, "length");
	assert.equal(toDoneReason(output.stopReason), "length");
});

test("applyMessageStopReason only forces toolUse when a tool call was observed", () => {
	const noToolOutput = createOutput();
	assert.equal(applyMessageStopReason(noToolOutput, false), false);
	assert.equal(noToolOutput.stopReason, "stop");

	const toolOutput = createOutput();
	assert.equal(applyMessageStopReason(toolOutput, true), true);
	assert.equal(toolOutput.stopReason, "toolUse");
	assert.equal(toDoneReason(toolOutput.stopReason), "toolUse");
});
