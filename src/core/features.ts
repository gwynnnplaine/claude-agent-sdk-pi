import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ClaudeAgentSdkProviderError, toProviderError } from "./errors.js";

export type ClaudeQueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;

export type BeforeQueryHookContext = {
	model: Model<any>;
	context: Context;
	options: SimpleStreamOptions | undefined;
	queryOptions: ClaudeQueryOptions;
};

export type StreamEventHookContext = {
	model: Model<any>;
	context: Context;
	options: SimpleStreamOptions | undefined;
	message: SDKMessage;
};

export type ToolCallHookContext<TArgs extends Record<string, unknown> = Record<string, unknown>> = {
	toolCallId: string;
	toolName: string;
	args: TArgs;
};

export type ToolResultHookContext<TResult = unknown> = {
	toolCallId: string;
	toolName: string;
	result: TResult;
	isError: boolean;
	timestamp: number;
};

export type ClaudeAgentSdkFeature = {
	name: string;
	onRegister?: (ctx: { pi: ExtensionAPI }) => void;
	beforeQuery?: (ctx: BeforeQueryHookContext) => void;
	onStreamEvent?: (ctx: StreamEventHookContext) => void;
	onToolCall?: (ctx: ToolCallHookContext) => void;
	onToolResult?: (ctx: ToolResultHookContext) => void;
};

export type TypedToolPlugin<TArgs extends Record<string, unknown>, TResult = unknown> = {
	name: string;
	toolName: string;
	decodeArgs: (args: Record<string, unknown>) => TArgs;
	decodeResult?: (result: unknown) => TResult;
	onToolCall?: (ctx: ToolCallHookContext<TArgs>) => void;
	onToolResult?: (ctx: ToolResultHookContext<TResult>) => void;
};

export function createToolPlugin<TArgs extends Record<string, unknown>, TResult = unknown>(
	plugin: TypedToolPlugin<TArgs, TResult>,
): ClaudeAgentSdkFeature {
	return {
		name: plugin.name,
		onToolCall: (ctx) => {
			if (ctx.toolName !== plugin.toolName) return;
			if (!plugin.onToolCall) return;
			plugin.onToolCall({
				toolCallId: ctx.toolCallId,
				toolName: ctx.toolName,
				args: plugin.decodeArgs(ctx.args),
			});
		},
		onToolResult: (ctx) => {
			if (ctx.toolName !== plugin.toolName) return;
			if (!plugin.onToolResult) return;
			const decodedResult = plugin.decodeResult ? plugin.decodeResult(ctx.result) : (ctx.result as TResult);
			plugin.onToolResult({
				toolCallId: ctx.toolCallId,
				toolName: ctx.toolName,
				result: decodedResult,
				isError: ctx.isError,
				timestamp: ctx.timestamp,
			});
		},
	};
}

export class FeatureRuntime {
	constructor(private readonly features: ReadonlyArray<ClaudeAgentSdkFeature>) {}

	register(pi: ExtensionAPI): void {
		for (const feature of this.features) {
			if (!feature.onRegister) continue;
			try {
				feature.onRegister({ pi });
			} catch (error) {
				throw toProviderError(error, "feature_hook_error", {
					featureName: feature.name,
					hook: "onRegister",
				});
			}
		}
	}

	runBeforeQuery(ctx: BeforeQueryHookContext): void {
		for (const feature of this.features) {
			if (!feature.beforeQuery) continue;
			try {
				feature.beforeQuery(ctx);
			} catch (error) {
				throw toProviderError(error, "feature_hook_error", {
					featureName: feature.name,
					hook: "beforeQuery",
				});
			}
		}
	}

	emitStreamEvent(ctx: StreamEventHookContext): void {
		for (const feature of this.features) {
			if (!feature.onStreamEvent) continue;
			try {
				feature.onStreamEvent(ctx);
			} catch (error) {
				throw toProviderError(error, "feature_hook_error", {
					featureName: feature.name,
					hook: "onStreamEvent",
					messageType: ctx.message.type,
				});
			}
		}
	}

	emitToolCall(ctx: ToolCallHookContext): void {
		for (const feature of this.features) {
			if (!feature.onToolCall) continue;
			try {
				feature.onToolCall(ctx);
			} catch (error) {
				throw toProviderError(error, "feature_hook_error", {
					featureName: feature.name,
					hook: "onToolCall",
				});
			}
		}
	}

	emitToolResult(ctx: ToolResultHookContext): void {
		for (const feature of this.features) {
			if (!feature.onToolResult) continue;
			try {
				feature.onToolResult(ctx);
			} catch (error) {
				throw toProviderError(error, "feature_hook_error", {
					featureName: feature.name,
					hook: "onToolResult",
				});
			}
		}
	}
}

export function createFeatureRuntime(features: ReadonlyArray<ClaudeAgentSdkFeature>): FeatureRuntime {
	return new FeatureRuntime(features);
}

export function reportFeatureError(error: unknown): ClaudeAgentSdkProviderError {
	return toProviderError(error, "feature_hook_error");
}
