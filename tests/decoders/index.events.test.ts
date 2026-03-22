import test from "node:test";
import assert from "node:assert/strict";
import {
	decodeLooseContext,
	decodeMessageEndEvent,
	decodeModelSelectProvider,
	decodeToolExecutionEndEvent,
	decodeToolExecutionStartEvent,
	decodeToolResultMessage,
} from "../../src/decoders/index.events.js";

test("decodeModelSelectProvider returns provider string when valid", () => {
	assert.equal(decodeModelSelectProvider({ model: { provider: "claude-agent-sdk" } }), "claude-agent-sdk");
	assert.equal(decodeModelSelectProvider({ model: {} }), undefined);
});

test("decodeLooseContext keeps callable session manager methods", () => {
	const ctx = decodeLooseContext({
		model: { provider: "claude-agent-sdk" },
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [1, 2],
		},
	});
	assert.equal(ctx.modelProvider, "claude-agent-sdk");
	assert.equal(ctx.sessionManager?.getSessionId?.(), "session-1");
	assert.deepEqual(ctx.sessionManager?.getBranch?.(), [1, 2]);
});

test("decodeMessageEndEvent + decodeToolResultMessage decode valid toolResult message", () => {
	const messageEvent = decodeMessageEndEvent({
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			isError: true,
			content: "oops",
			timestamp: 123,
		},
	});
	assert.ok(messageEvent);
	if (!messageEvent) return;
	assert.equal(messageEvent.role, "toolResult");
	assert.equal(messageEvent.timestamp, 123);
	const toolResult = decodeToolResultMessage(messageEvent.message);
	assert.deepEqual(toolResult, {
		toolCallId: "call-1",
		toolName: "read",
		content: "oops",
		isError: true,
	});
});

test("decodeToolExecutionStartEvent/decodeToolExecutionEndEvent reject malformed", () => {
	assert.equal(decodeToolExecutionStartEvent({ toolCallId: 1, toolName: "read" }), undefined);
	assert.equal(decodeToolExecutionEndEvent({ toolCallId: "1", toolName: null }), undefined);
});
