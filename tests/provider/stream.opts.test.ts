import test from "node:test";
import assert from "node:assert/strict";
import { mapThinkingTokens } from "../../src/provider/stream.opts.js";

test("mapThinkingTokens maps xhigh->high for non-opus-4-6 and respects custom budgets", () => {
	assert.equal(mapThinkingTokens("xhigh", "claude-sonnet-4-20250514"), 31999);
	assert.equal(
		mapThinkingTokens("high", "claude-sonnet-4-20250514", { high: 42000 }),
		42000,
	);
	assert.equal(
		mapThinkingTokens("high", "claude-sonnet-4-20250514", { high: -1 }),
		31999,
	);
});

test("mapThinkingTokens uses opus-4-6 table", () => {
	assert.equal(mapThinkingTokens("medium", "claude-opus-4-6-20260101"), 31999);
	assert.equal(mapThinkingTokens("xhigh", "claude-opus-4.6-20260101"), 63999);
});
