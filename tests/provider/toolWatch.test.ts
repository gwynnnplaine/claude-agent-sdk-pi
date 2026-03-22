import test from "node:test";
import assert from "node:assert/strict";
import { ToolWatchStore, TOOL_WATCH_CUSTOM_TYPE, type ToolWatchCustomEntryData } from "../../src/provider/toolWatch.js";
import type { Context } from "@mariozechner/pi-ai";

function createContext(messages: Context["messages"]): Context {
	return { messages };
}

test("ToolWatchStore builds recovered tool-result note", () => {
	const store = new ToolWatchStore();
	const sessionKey = "session:abc";

	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: 10,
				content: [{ type: "toolCall", id: "call-1", name: "read" }],
			},
		},
		{
			type: "custom",
			customType: TOOL_WATCH_CUSTOM_TYPE,
			data: {
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "read",
				content: "file content",
				isError: false,
				timestamp: 11,
			} satisfies ToolWatchCustomEntryData,
		},
	];

	store.hydrateFromEntries(sessionKey, entries);

	const note = store.buildPromptNote(
		sessionKey,
		createContext([
			{
				role: "assistant",
				timestamp: 10,
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
			},
		]),
	);

	assert.ok(note?.includes("TOOL RESULT (recovered Read, id=call-1, status=ok):"));
	assert.ok(note?.includes("file content"));
});

test("ToolWatchStore builds missing execution note for unresolved tool call", () => {
	const store = new ToolWatchStore();
	const sessionKey = "session:abc";

	store.hydrateFromEntries(sessionKey, [
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: 10,
				content: [{ type: "toolCall", id: "call-2", name: "read" }],
			},
		},
	]);

	const note = store.buildPromptNote(
		sessionKey,
		createContext([
			{
				role: "assistant",
				timestamp: 10,
				content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
			},
		]),
	);

	assert.ok(note?.includes("TOOL RESULT (missing execution Read, id=call-2, status=error):"));
});

test("ToolWatchStore ignores malformed entries during hydration", () => {
	const store = new ToolWatchStore();
	const sessionKey = "session:bad";

	store.hydrateFromEntries(sessionKey, [
		{ type: "message", message: { role: "toolResult", toolCallId: 7, toolName: "read" } },
		{ type: "custom", customType: TOOL_WATCH_CUSTOM_TYPE, data: { type: "tool_execution_end", toolCallId: "ok" } },
	]);

	const note = store.buildPromptNote(
		sessionKey,
		createContext([
			{
				role: "assistant",
				timestamp: 10,
				content: [{ type: "toolCall", id: "ok", name: "read", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
			},
		]),
	);

	assert.equal(note, undefined);
});
