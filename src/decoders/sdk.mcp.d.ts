import "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

declare module "@anthropic-ai/claude-agent-sdk" {
	export function createSdkMcpServer(_options: {
		name: string;
		version?: string;
		tools?: Array<{
			name: string;
			description: string;
			inputSchema: unknown;
			handler: (args: unknown, extra: unknown) => Promise<unknown>;
		}>;
	}): McpSdkServerConfigWithInstance;
}
