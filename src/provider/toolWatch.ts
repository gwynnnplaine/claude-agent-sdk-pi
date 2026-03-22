import type { Context, SimpleStreamOptions } from "@mariozechner/pi-ai";
import {
	decodeAssistantToolCalls,
	decodeContentToPlainText,
	decodeCustomToolExecutionEndEntry,
	decodeHydrationMessageEntry,
	decodeObjectField,
} from "../decoders/toolWatch.entries.js";
import { mapPiToolNameToSdk } from "../mapping/toolNames.js";

export const TOOL_WATCH_CUSTOM_TYPE = "claude-agent-sdk-tool-watch";

const MAX_TRACKED_TOOL_EXECUTIONS = 256;
const MAX_TRACKED_TOOL_CONTENT_CHARS = 4000;
const MAX_LEDGER_TOOL_RESULTS = 4;
const MAX_LEDGER_TOOL_CONTENT_CHARS = 1200;

export type ToolWatchCustomEntryData = {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type PendingToolCall = {
	toolName: string;
	timestamp: number;
};

type TrackedToolExecution = {
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type SessionToolWatchState = {
	pendingToolCalls: Map<string, PendingToolCall>;
	completedToolCalls: Map<string, TrackedToolExecution>;
};

export class ToolWatchStore {
	private readonly stateBySession = new Map<string, SessionToolWatchState>();

	private createEmptyState(): SessionToolWatchState {
		return {
			pendingToolCalls: new Map(),
			completedToolCalls: new Map(),
		};
	}

	private getOrCreateState(sessionKey: string): SessionToolWatchState {
		const existing = this.stateBySession.get(sessionKey);
		if (existing) return existing;
		const created = this.createEmptyState();
		this.stateBySession.set(sessionKey, created);
		return created;
	}

	private truncateText(text: string, limit: number): string {
		if (text.length <= limit) return text;
		return `${text.slice(0, limit)}\n...[truncated]`;
	}

	private stringifyUnknown(value: unknown): string {
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	getSessionKeyFromSessionId(sessionId?: string): string | undefined {
		if (!sessionId) return undefined;
		return `session:${sessionId}`;
	}

	getSessionKeyFromStreamOptions(options?: SimpleStreamOptions, activeSessionKey?: string): string | undefined {
		const fromOptions = this.getSessionKeyFromSessionId(options?.sessionId);
		if (fromOptions) return fromOptions;
		return activeSessionKey;
	}

	getSessionKeyFromContext(
		ctx?: { sessionManager?: { getSessionId?: () => string } | undefined } | undefined,
	): string | undefined {
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (!sessionId) return undefined;
		return this.getSessionKeyFromSessionId(sessionId);
	}

	deleteSession(sessionKey: string): void {
		this.stateBySession.delete(sessionKey);
	}

	contentToPlainText(content: unknown): string {
		return decodeContentToPlainText(content);
	}

	extractToolExecutionContent(result: unknown): string {
		const resultContent = decodeObjectField(result, "content");
		if (resultContent !== undefined) {
			const text = this.contentToPlainText(resultContent);
			if (text) return this.truncateText(text, MAX_TRACKED_TOOL_CONTENT_CHARS);
		}
		const fallback = this.stringifyUnknown(result);
		return this.truncateText(fallback, MAX_TRACKED_TOOL_CONTENT_CHARS);
	}

	collectAssistantToolCalls(message: unknown): Array<{ id: string; name: string }> {
		return decodeAssistantToolCalls(message);
	}

	trackPendingToolCall(sessionKey: string, toolCallId: string, toolName: string, timestamp: number): void {
		const state = this.getOrCreateState(sessionKey);
		if (state.completedToolCalls.has(toolCallId)) return;
		state.pendingToolCalls.set(toolCallId, { toolName, timestamp });
	}

	trackCompletedToolCall(sessionKey: string, execution: TrackedToolExecution): void {
		const state = this.getOrCreateState(sessionKey);
		state.pendingToolCalls.delete(execution.toolCallId);
		state.completedToolCalls.delete(execution.toolCallId);
		state.completedToolCalls.set(execution.toolCallId, execution);
		while (state.completedToolCalls.size > MAX_TRACKED_TOOL_EXECUTIONS) {
			const oldestKey = state.completedToolCalls.keys().next().value;
			if (!oldestKey) break;
			state.completedToolCalls.delete(oldestKey);
		}
	}

	hydrateFromEntries(sessionKey: string, entries: ReadonlyArray<unknown>): void {
		this.stateBySession.set(sessionKey, this.createEmptyState());
		for (const entry of entries) {
			const messageEntry = decodeHydrationMessageEntry(entry);
			if (messageEntry) {
				if (messageEntry.role === "assistant") {
					for (const toolCall of this.collectAssistantToolCalls(messageEntry.message)) {
						this.trackPendingToolCall(sessionKey, toolCall.id, toolCall.name, messageEntry.timestamp);
					}
					continue;
				}

				this.trackCompletedToolCall(sessionKey, {
					toolCallId: messageEntry.toolCallId,
					toolName: messageEntry.toolName,
					content: this.truncateText(this.contentToPlainText(messageEntry.content), MAX_TRACKED_TOOL_CONTENT_CHARS),
					isError: messageEntry.isError,
					timestamp: messageEntry.timestamp,
				});
				continue;
			}

			const customEntry = decodeCustomToolExecutionEndEntry(entry, TOOL_WATCH_CUSTOM_TYPE);
			if (!customEntry) continue;
			this.trackCompletedToolCall(sessionKey, {
				toolCallId: customEntry.toolCallId,
				toolName: customEntry.toolName,
				content: this.truncateText(customEntry.content, MAX_TRACKED_TOOL_CONTENT_CHARS),
				isError: customEntry.isError,
				timestamp: customEntry.timestamp,
			});
		}
	}

	reconcileWithContext(sessionKey: string, context: Context): void {
		const state = this.stateBySession.get(sessionKey);
		if (!state) return;
		for (const message of context.messages) {
			if (message.role === "assistant") {
				for (const toolCall of this.collectAssistantToolCalls(message)) {
					if (!state.completedToolCalls.has(toolCall.id)) {
						this.trackPendingToolCall(sessionKey, toolCall.id, toolCall.name, message.timestamp);
					}
				}
				continue;
			}
			if (message.role === "toolResult") {
				state.pendingToolCalls.delete(message.toolCallId);
				if (!state.completedToolCalls.has(message.toolCallId)) {
					this.trackCompletedToolCall(sessionKey, {
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						content: this.truncateText(this.contentToPlainText(message.content), MAX_TRACKED_TOOL_CONTENT_CHARS),
						isError: message.isError,
						timestamp: message.timestamp,
					});
				}
			}
		}
	}

	buildPromptNote(
		sessionKey: string | undefined,
		context: Context,
		customToolNameToSdk?: Map<string, string>,
	): string | undefined {
		if (!sessionKey) return undefined;
		const state = this.stateBySession.get(sessionKey);
		if (!state) return undefined;

		const toolResultIdsInContext = new Set<string>();
		const assistantToolIdsInContext = new Set<string>();
		for (const message of context.messages) {
			if (message.role === "assistant") {
				for (const toolCall of this.collectAssistantToolCalls(message)) {
					assistantToolIdsInContext.add(toolCall.id);
				}
				continue;
			}
			if (message.role === "toolResult") {
				toolResultIdsInContext.add(message.toolCallId);
			}
		}

		const recoveredExecutions = Array.from(state.completedToolCalls.values())
			.filter((execution) => {
				if (toolResultIdsInContext.has(execution.toolCallId)) return false;
				return assistantToolIdsInContext.has(execution.toolCallId) || state.pendingToolCalls.has(execution.toolCallId);
			})
			.sort((a, b) => b.timestamp - a.timestamp)
			.slice(0, MAX_LEDGER_TOOL_RESULTS);

		const unresolvedToolCalls = Array.from(state.pendingToolCalls.entries())
			.filter(([toolCallId]) => {
				if (toolResultIdsInContext.has(toolCallId)) return false;
				return assistantToolIdsInContext.has(toolCallId);
			})
			.sort((a, b) => b[1].timestamp - a[1].timestamp)
			.slice(0, MAX_LEDGER_TOOL_RESULTS);

		if (!recoveredExecutions.length && !unresolvedToolCalls.length) return undefined;

		const parts: string[] = [];

		if (recoveredExecutions.length) {
			for (const execution of recoveredExecutions) {
				const sdkToolName = mapPiToolNameToSdk(execution.toolName, customToolNameToSdk);
				const status = execution.isError ? "error" : "ok";
				const content = this.truncateText(execution.content || "(empty tool result)", MAX_LEDGER_TOOL_CONTENT_CHARS);
				parts.push(
					`TOOL RESULT (recovered ${sdkToolName}, id=${execution.toolCallId}, status=${status}):\n${content}`,
				);
			}
		}

		if (unresolvedToolCalls.length) {
			for (const [toolCallId, pending] of unresolvedToolCalls) {
				const sdkToolName = mapPiToolNameToSdk(pending.toolName, customToolNameToSdk);
				parts.push(
					`TOOL RESULT (missing execution ${sdkToolName}, id=${toolCallId}, status=error):\n` +
						"Tool execution did not complete or its result was not observed. Do not guess. Call the tool again.",
				);
			}
		}

		return parts.join("\n\n");
	}
}
