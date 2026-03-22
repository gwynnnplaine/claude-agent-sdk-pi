import test from "node:test";
import assert from "node:assert/strict";
import { applyStreamThinkingEvent } from "../../src/provider/stream.thinking.js";
import type { StreamBlock } from "../../src/provider/stream.ctx.js";

test("applyStreamThinkingEvent emits start/delta/end and accumulates signature", () => {
	const blocks: StreamBlock[] = [];

	const start = applyStreamThinkingEvent(blocks, {
		type: "content_block_start",
		index: 2,
		contentBlock: { type: "thinking" },
	});
	assert.deepEqual(start, [{ type: "thinking_start", contentIndex: 0 }]);

	const delta = applyStreamThinkingEvent(blocks, {
		type: "content_block_delta",
		index: 2,
		delta: { type: "thinking_delta", thinking: "plan" },
	});
	assert.deepEqual(delta, [{ type: "thinking_delta", contentIndex: 0, delta: "plan" }]);

	const signatureDelta = applyStreamThinkingEvent(blocks, {
		type: "content_block_delta",
		index: 2,
		delta: { type: "signature_delta", signature: "sig-1" },
	});
	assert.deepEqual(signatureDelta, []);

	const end = applyStreamThinkingEvent(blocks, {
		type: "content_block_stop",
		index: 2,
	});
	assert.deepEqual(end, [{ type: "thinking_end", contentIndex: 0, content: "plan" }]);

	const block = blocks[0];
	assert.ok(block);
	assert.equal(block.type, "thinking");
	assert.equal(block.thinking, "plan");
	assert.equal(block.thinkingSignature, "sig-1");
	assert.equal(block.index, undefined);
});
