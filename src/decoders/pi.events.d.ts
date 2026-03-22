import type { ExtensionHandler } from "@mariozechner/pi-coding-agent";

declare module "@mariozechner/pi-coding-agent" {
	interface ExtensionAPI {
		on(event: "message_end", handler: ExtensionHandler<{ message?: unknown }>): void;
		on(
			event: "tool_execution_start",
			handler: ExtensionHandler<{ toolCallId?: unknown; toolName?: unknown }>,
		): void;
		on(
			event: "tool_execution_end",
			handler: ExtensionHandler<{ toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown }>,
		): void;
	}
}
