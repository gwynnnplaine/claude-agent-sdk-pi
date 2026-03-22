import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import {
	createFeatureRuntime,
	createToolPlugin,
	type BeforeQueryHookContext,
	type ToolCallHookContext,
	type ToolResultHookContext,
} from "../../src/core/features.js";
import { ClaudeAgentSdkProviderError } from "../../src/core/errors.js";

function createModel(): Model<Api> {
	return {
		id: "model-1",
		name: "Model 1",
		api: "claude-agent-sdk",
		provider: "anthropic",
		baseUrl: "claude-agent-sdk",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function createContext(): Context {
	return { messages: [] };
}

function createBeforeQueryCtx(): BeforeQueryHookContext {
	return {
		model: createModel(),
		context: createContext(),
		options: undefined,
		queryOptions: {},
	};
}

test("FeatureRuntime runs beforeQuery hooks in registration order", async () => {
	const calls: string[] = [];
	const runtime = createFeatureRuntime([
		{
			name: "first",
			beforeQuery: () => {
				calls.push("first");
			},
		},
		{
			name: "second",
			beforeQuery: () => {
				calls.push("second");
			},
		},
	]);

	await runtime.runBeforeQuery(createBeforeQueryCtx());

	assert.deepEqual(calls, ["first", "second"]);
});

test("FeatureRuntime wraps failing hooks as ClaudeAgentSdkProviderError", async () => {
	const runtime = createFeatureRuntime([
		{
			name: "boom",
			onToolCall: () => {
				throw new Error("kaboom");
			},
		},
	]);

	await assert.rejects(
		async () => runtime.emitToolCall({ toolCallId: "id", toolName: "read", args: {} }),
		(error: unknown) => {
			assert.ok(error instanceof ClaudeAgentSdkProviderError);
			assert.equal(error.code, "feature_hook_error");
			assert.equal(error.message, "kaboom");
			assert.equal(error.details.featureName, "boom");
			assert.equal(error.details.hook, "onToolCall");
			return true;
		},
	);
});

test("FeatureRuntime wraps async hook rejections as ClaudeAgentSdkProviderError", async () => {
	const runtime = createFeatureRuntime([
		{
			name: "async-boom",
			onToolCall: async () => {
				throw new Error("async kaboom");
			},
		},
	]);

	await assert.rejects(
		async () => runtime.emitToolCall({ toolCallId: "id", toolName: "read", args: {} }),
		(error: unknown) => {
			assert.ok(error instanceof ClaudeAgentSdkProviderError);
			assert.equal(error.code, "feature_hook_error");
			assert.equal(error.message, "async kaboom");
			assert.equal(error.details.featureName, "async-boom");
			assert.equal(error.details.hook, "onToolCall");
			return true;
		},
	);
});

test("createToolPlugin decodes args/result before invoking typed hooks", async () => {
	let seenCall: ToolCallHookContext<{ path: string }> | undefined;
	let seenResult: ToolResultHookContext<{ ok: boolean }> | undefined;

	const runtime = createFeatureRuntime([
		createToolPlugin({
			name: "typed-read",
			toolName: "read",
			decodeArgs: (args) => ({ path: String(args.path ?? "") }),
			decodeResult: (result) => ({ ok: result === "done" }),
			onToolCall: (ctx) => {
				seenCall = ctx;
			},
			onToolResult: (ctx) => {
				seenResult = ctx;
			},
		}),
	]);

	await runtime.emitToolCall({ toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a" } });
	await runtime.emitToolResult({
		toolCallId: "call-1",
		toolName: "read",
		result: "done",
		isError: false,
		timestamp: 1,
	});

	assert.deepEqual(seenCall, {
		toolCallId: "call-1",
		toolName: "read",
		args: { path: "/tmp/a" },
	});
	assert.deepEqual(seenResult, {
		toolCallId: "call-1",
		toolName: "read",
		result: { ok: true },
		isError: false,
		timestamp: 1,
	});
});

test("createToolPlugin passes through unknown result when decodeResult is omitted", async () => {
	let seenResult: ToolResultHookContext<unknown> | undefined;

	const runtime = createFeatureRuntime([
		createToolPlugin({
			name: "typed-read",
			toolName: "read",
			decodeArgs: (args) => ({ path: String(args.path ?? "") }),
			onToolResult: (ctx) => {
				seenResult = ctx;
			},
		}),
	]);

	await runtime.emitToolResult({
		toolCallId: "call-1",
		toolName: "read",
		result: { ok: true },
		isError: false,
		timestamp: 1,
	});

	assert.deepEqual(seenResult, {
		toolCallId: "call-1",
		toolName: "read",
		result: { ok: true },
		isError: false,
		timestamp: 1,
	});
});

test("createToolPlugin failures are wrapped by runtime", async () => {
	const runtime = createFeatureRuntime([
		createToolPlugin({
			name: "typed-read",
			toolName: "read",
			decodeArgs: () => {
				throw new Error("decode fail");
			},
			onToolCall: () => {
				// noop
			},
		}),
	]);

	await assert.rejects(
		async () => runtime.emitToolCall({ toolCallId: "call-1", toolName: "read", args: {} }),
		(error: unknown) => {
			assert.ok(error instanceof ClaudeAgentSdkProviderError);
			assert.equal(error.code, "feature_hook_error");
			assert.equal(error.message, "decode fail");
			assert.equal(error.details.featureName, "typed-read");
			return true;
		},
	);
});
