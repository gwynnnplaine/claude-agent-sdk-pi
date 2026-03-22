import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Effect, Either } from "effect";
import { ClaudeAgentSdkProviderError, toProviderError } from "./errors.js";

export type ClaudeQueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;

export type BeforeQueryHookContext = {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions | undefined;
	queryOptions: ClaudeQueryOptions;
};

export type StreamEventHookContext = {
	model: Model<Api>;
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

type TypedToolPluginBase<TArgs extends Record<string, unknown>> = {
	name: string;
	toolName: string;
	decodeArgs: (args: Record<string, unknown>) => TArgs;
	onToolCall?: (ctx: ToolCallHookContext<TArgs>) => void;
};

type TypedToolPluginWithoutResultDecoder<TArgs extends Record<string, unknown>> = TypedToolPluginBase<TArgs> & {
	decodeResult?: undefined;
	onToolResult?: (ctx: ToolResultHookContext<unknown>) => void;
};

type TypedToolPluginWithResultDecoder<TArgs extends Record<string, unknown>, TResult> = TypedToolPluginBase<TArgs> & {
	decodeResult: (result: unknown) => TResult;
	onToolResult?: (ctx: ToolResultHookContext<TResult>) => void;
};

export type TypedToolPlugin<TArgs extends Record<string, unknown>, TResult = unknown> =
	| TypedToolPluginWithoutResultDecoder<TArgs>
	| TypedToolPluginWithResultDecoder<TArgs, TResult>;

export function createToolPlugin<TArgs extends Record<string, unknown>>(
	plugin: TypedToolPluginWithoutResultDecoder<TArgs>,
): ClaudeAgentSdkFeature;

export function createToolPlugin<TArgs extends Record<string, unknown>, TResult>(
	plugin: TypedToolPluginWithResultDecoder<TArgs, TResult>,
): ClaudeAgentSdkFeature;

export function createToolPlugin<TArgs extends Record<string, unknown>, TResult>(
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
			if (plugin.decodeResult) {
				plugin.onToolResult({
					toolCallId: ctx.toolCallId,
					toolName: ctx.toolName,
					result: plugin.decodeResult(ctx.result),
					isError: ctx.isError,
					timestamp: ctx.timestamp,
				});
				return;
			}
			plugin.onToolResult({
				toolCallId: ctx.toolCallId,
				toolName: ctx.toolName,
				result: ctx.result,
				isError: ctx.isError,
				timestamp: ctx.timestamp,
			});
		},
	};
}

export class FeatureRuntime {
	constructor(private readonly features: ReadonlyArray<ClaudeAgentSdkFeature>) {}

	private runHookEffect(effect: Effect.Effect<void, ClaudeAgentSdkProviderError>): void {
		const result = Effect.runSync(Effect.either(effect));
		if (Either.isLeft(result)) throw result.left;
	}

	private invokeHook(
		feature: ClaudeAgentSdkFeature,
		hook: NonNullable<ClaudeAgentSdkProviderError["details"]["hook"]>,
		run: () => void,
		extraDetails: ClaudeAgentSdkProviderError["details"] = {},
	): Effect.Effect<void, ClaudeAgentSdkProviderError> {
		return Effect.try({
			try: run,
			catch: (error) =>
				toProviderError(error, "feature_hook_error", {
					...extraDetails,
					featureName: feature.name,
					hook,
				}),
		});
	}

	register(pi: ExtensionAPI): void {
		const program = Effect.forEach(this.features, (feature) => {
			if (!feature.onRegister) return Effect.void;
			return this.invokeHook(feature, "onRegister", () => {
				feature.onRegister?.({ pi });
			});
		}, { discard: true });
		this.runHookEffect(program);
	}

	runBeforeQuery(ctx: BeforeQueryHookContext): void {
		const program = Effect.forEach(this.features, (feature) => {
			if (!feature.beforeQuery) return Effect.void;
			return this.invokeHook(feature, "beforeQuery", () => {
				feature.beforeQuery?.(ctx);
			});
		}, { discard: true });
		this.runHookEffect(program);
	}

	emitStreamEvent(ctx: StreamEventHookContext): void {
		const program = Effect.forEach(this.features, (feature) => {
			if (!feature.onStreamEvent) return Effect.void;
			return this.invokeHook(
				feature,
				"onStreamEvent",
				() => {
					feature.onStreamEvent?.(ctx);
				},
				{ messageType: ctx.message.type },
			);
		}, { discard: true });
		this.runHookEffect(program);
	}

	emitToolCall(ctx: ToolCallHookContext): void {
		const program = Effect.forEach(this.features, (feature) => {
			if (!feature.onToolCall) return Effect.void;
			return this.invokeHook(feature, "onToolCall", () => {
				feature.onToolCall?.(ctx);
			});
		}, { discard: true });
		this.runHookEffect(program);
	}

	emitToolResult(ctx: ToolResultHookContext): void {
		const program = Effect.forEach(this.features, (feature) => {
			if (!feature.onToolResult) return Effect.void;
			return this.invokeHook(feature, "onToolResult", () => {
				feature.onToolResult?.(ctx);
			});
		}, { discard: true });
		this.runHookEffect(program);
	}
}

export function createFeatureRuntime(features: ReadonlyArray<ClaudeAgentSdkFeature>): FeatureRuntime {
	return new FeatureRuntime(features);
}

export function reportFeatureError(error: unknown): ClaudeAgentSdkProviderError {
	return toProviderError(error, "feature_hook_error");
}
