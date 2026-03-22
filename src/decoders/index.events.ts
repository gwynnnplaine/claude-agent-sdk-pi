import { Effect, Either, Schema } from "effect";

const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

type UnknownRecord = Record<string, unknown>;

type DecodedSessionManager = {
	getSessionId?: () => string;
	getBranch?: () => ReadonlyArray<unknown>;
};

export type DecodedLooseContext = {
	modelProvider?: string;
	sessionManager?: DecodedSessionManager;
};

export type DecodedMessageEndEvent = {
	message: UnknownRecord;
	role?: string;
	timestamp?: number;
};

export type DecodedToolExecutionStartEvent = {
	toolCallId: string;
	toolName: string;
};

export type DecodedToolExecutionEndEvent = {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
};

export type DecodedToolResultMessage = {
	toolCallId: string;
	toolName: string;
	content: unknown;
	isError: boolean;
};

function decodeRecord(value: unknown): UnknownRecord | undefined {
	const decoded = Schema.decodeUnknownEither(UnknownRecordSchema)(value);
	if (Either.isLeft(decoded)) return undefined;
	return decoded.right;
}

function decodeOptionalRecord(value: unknown, key: string): UnknownRecord | undefined {
	if (!value) return undefined;
	const record = decodeRecord(value);
	if (!record) return undefined;
	return decodeRecord(record[key]);
}

function decodeOptionalString(record: UnknownRecord | undefined, key: string): string | undefined {
	if (!record) return undefined;
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function decodeOptionalFiniteNumber(record: UnknownRecord | undefined, key: string): number | undefined {
	if (!record) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeGetSessionId(value: unknown): (() => string) | undefined {
	if (typeof value !== "function") return undefined;
	return () => {
		const output = Effect.runSync(
			Effect.try({
				try: () => value(),
				catch: () => "",
			}),
		);
		return typeof output === "string" ? output : "";
	};
}

function decodeGetBranch(value: unknown): (() => ReadonlyArray<unknown>) | undefined {
	if (typeof value !== "function") return undefined;
	return () => {
		const output = Effect.runSync(
			Effect.try({
				try: () => value(),
				catch: () => [],
			}),
		);
		return Array.isArray(output) ? output : [];
	};
}

function decodeSessionManager(value: unknown): DecodedSessionManager | undefined {
	const record = decodeRecord(value);
	if (!record) return undefined;
	const getSessionId = decodeGetSessionId(record.getSessionId);
	const getBranch = decodeGetBranch(record.getBranch);
	if (!getSessionId && !getBranch) return undefined;
	return {
		...(getSessionId ? { getSessionId } : {}),
		...(getBranch ? { getBranch } : {}),
	};
}

export function decodeModelSelectProvider(event: unknown): string | undefined {
	const model = decodeOptionalRecord(event, "model");
	return decodeOptionalString(model, "provider");
}

export function decodeLooseContext(ctx: unknown): DecodedLooseContext {
	const record = decodeRecord(ctx);
	if (!record) return {};
	const model = decodeOptionalRecord(record, "model");
	const modelProvider = decodeOptionalString(model, "provider");
	const sessionManager = decodeSessionManager(record.sessionManager);
	return {
		...(modelProvider ? { modelProvider } : {}),
		...(sessionManager ? { sessionManager } : {}),
	};
}

export function decodeMessageEndEvent(event: unknown): DecodedMessageEndEvent | undefined {
	const record = decodeRecord(event);
	if (!record) return undefined;
	const message = decodeRecord(record.message);
	if (!message) return undefined;
	const role = decodeOptionalString(message, "role");
	const timestamp = decodeOptionalFiniteNumber(message, "timestamp");
	return {
		message,
		...(role ? { role } : {}),
		...(timestamp != null ? { timestamp } : {}),
	};
}

function decodeStringField(record: UnknownRecord | undefined, key: string): string | undefined {
	if (!record) return undefined;
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

export function decodeToolExecutionStartEvent(event: unknown): DecodedToolExecutionStartEvent | undefined {
	const record = decodeRecord(event);
	if (!record) return undefined;
	const toolCallId = decodeStringField(record, "toolCallId");
	const toolName = decodeStringField(record, "toolName");
	if (!toolCallId || !toolName) return undefined;
	return { toolCallId, toolName };
}

export function decodeToolExecutionEndEvent(event: unknown): DecodedToolExecutionEndEvent | undefined {
	const record = decodeRecord(event);
	if (!record) return undefined;
	const toolCallId = decodeStringField(record, "toolCallId");
	const toolName = decodeStringField(record, "toolName");
	if (!toolCallId || !toolName) return undefined;
	return {
		toolCallId,
		toolName,
		result: record.result,
		isError: record.isError === true,
	};
}

export function decodeToolResultMessage(message: unknown): DecodedToolResultMessage | undefined {
	const record = decodeRecord(message);
	if (!record) return undefined;
	const toolCallId = decodeStringField(record, "toolCallId");
	const toolName = decodeStringField(record, "toolName");
	if (!toolCallId || !toolName) return undefined;
	return {
		toolCallId,
		toolName,
		content: record.content,
		isError: record.isError === true,
	};
}
