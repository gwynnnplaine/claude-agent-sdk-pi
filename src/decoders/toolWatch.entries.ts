import { Either, Schema } from "effect";

const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

type UnknownRecord = Record<string, unknown>;

export type DecodedAssistantToolCall = {
	id: string;
	name: string;
};

export type DecodedHydrationMessageEntry =
	| {
			role: "assistant";
			message: UnknownRecord;
			timestamp: number;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: unknown;
			isError: boolean;
			timestamp: number;
	  };

export type DecodedCustomToolExecutionEndEntry = {
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

function decodeRecord(value: unknown): UnknownRecord | undefined {
	const decoded = Schema.decodeUnknownEither(UnknownRecordSchema)(value);
	if (Either.isLeft(decoded)) return undefined;
	return decoded.right;
}

export function decodeObjectField(value: unknown, key: string): unknown {
	const record = decodeRecord(value);
	if (!record) return undefined;
	return record[key];
}

function decodeStringField(record: UnknownRecord | undefined, key: string): string | undefined {
	if (!record) return undefined;
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function decodeBooleanField(record: UnknownRecord | undefined, key: string): boolean | undefined {
	if (!record) return undefined;
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function decodeFiniteNumberField(record: UnknownRecord | undefined, key: string): number | undefined {
	if (!record) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeTimestamp(record: UnknownRecord | undefined, key: string): number {
	return decodeFiniteNumberField(record, key) ?? Date.now();
}

export function decodeContentToPlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const contentBlock = decodeRecord(block);
			const blockType = decodeStringField(contentBlock, "type");
			if (blockType === "text") return decodeStringField(contentBlock, "text") ?? "";
			if (blockType === "image") return `[image:${decodeStringField(contentBlock, "mimeType") ?? "unknown"}]`;
			if (blockType) return `[${blockType}]`;
			return "";
		})
		.filter((line) => line.length > 0)
		.join("\n");
}

export function decodeAssistantToolCalls(message: unknown): DecodedAssistantToolCall[] {
	const record = decodeRecord(message);
	if (!record) return [];
	if (decodeStringField(record, "role") !== "assistant") return [];
	if (!Array.isArray(record.content)) return [];

	const toolCalls: DecodedAssistantToolCall[] = [];
	for (const block of record.content) {
		const toolCallRecord = decodeRecord(block);
		if (!toolCallRecord) continue;
		if (decodeStringField(toolCallRecord, "type") !== "toolCall") continue;
		const id = decodeStringField(toolCallRecord, "id");
		const name = decodeStringField(toolCallRecord, "name");
		if (!id || !name) continue;
		toolCalls.push({ id, name });
	}

	return toolCalls;
}

export function decodeHydrationMessageEntry(entry: unknown): DecodedHydrationMessageEntry | undefined {
	const entryRecord = decodeRecord(entry);
	if (!entryRecord) return undefined;
	if (decodeStringField(entryRecord, "type") !== "message") return undefined;

	const message = decodeRecord(entryRecord.message);
	if (!message) return undefined;
	const role = decodeStringField(message, "role");
	if (role === "assistant") {
		return {
			role: "assistant",
			message,
			timestamp: decodeTimestamp(message, "timestamp"),
		};
	}

	if (role === "toolResult") {
		const toolCallId = decodeStringField(message, "toolCallId");
		const toolName = decodeStringField(message, "toolName");
		if (!toolCallId || !toolName) return undefined;
		return {
			role: "toolResult",
			toolCallId,
			toolName,
			content: message.content,
			isError: decodeBooleanField(message, "isError") === true,
			timestamp: decodeTimestamp(message, "timestamp"),
		};
	}

	return undefined;
}

export function decodeCustomToolExecutionEndEntry(
	entry: unknown,
	customType: string,
): DecodedCustomToolExecutionEndEntry | undefined {
	const entryRecord = decodeRecord(entry);
	if (!entryRecord) return undefined;
	if (decodeStringField(entryRecord, "type") !== "custom") return undefined;
	if (decodeStringField(entryRecord, "customType") !== customType) return undefined;

	const data = decodeRecord(entryRecord.data);
	if (!data) return undefined;
	if (decodeStringField(data, "type") !== "tool_execution_end") return undefined;

	const toolCallId = decodeStringField(data, "toolCallId");
	const toolName = decodeStringField(data, "toolName");
	if (!toolCallId || !toolName) return undefined;

	return {
		toolCallId,
		toolName,
		content: decodeStringField(data, "content") ?? "",
		isError: decodeBooleanField(data, "isError") === true,
		timestamp: decodeTimestamp(data, "timestamp"),
	};
}
