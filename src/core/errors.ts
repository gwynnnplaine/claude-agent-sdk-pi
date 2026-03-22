export const CLAUDE_AGENT_SDK_PROVIDER_ERROR_CODES = [
	"feature_hook_error",
	"stream_error",
	"query_setup_error",
	"invalid_sdk_event",
] as const;

export type ClaudeAgentSdkProviderErrorCode = (typeof CLAUDE_AGENT_SDK_PROVIDER_ERROR_CODES)[number];

export type ClaudeAgentSdkProviderErrorDetails = {
	featureName?: string;
	hook?: "onRegister" | "beforeQuery" | "onStreamEvent" | "onToolCall" | "onToolResult";
	messageType?: string;
};

export class ClaudeAgentSdkProviderError extends Error {
	readonly name = "ClaudeAgentSdkProviderError";

	constructor(
		readonly code: ClaudeAgentSdkProviderErrorCode,
		message: string,
		readonly details: ClaudeAgentSdkProviderErrorDetails = {},
		readonly cause?: unknown,
	) {
		super(message);
	}
}

export function toProviderError(
	error: unknown,
	fallbackCode: ClaudeAgentSdkProviderErrorCode,
	details: ClaudeAgentSdkProviderErrorDetails = {},
): ClaudeAgentSdkProviderError {
	if (error instanceof ClaudeAgentSdkProviderError) return error;
	if (error instanceof Error) {
		return new ClaudeAgentSdkProviderError(fallbackCode, error.message, details, error);
	}
	return new ClaudeAgentSdkProviderError(fallbackCode, String(error), details, error);
}
