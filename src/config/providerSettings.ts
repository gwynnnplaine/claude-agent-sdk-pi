import { type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { existsSync, readFileSync } from "fs";
import { GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_PATH } from "../core/constants.js";

export type ProviderSettings = {
	appendSystemPrompt?: boolean;
	settingSources?: SettingSource[];
	strictMcpConfig?: boolean;
};

type JsonRecord = Record<string, unknown>;

const ALLOWED_SETTING_SOURCES: ReadonlySet<string> = new Set(["user", "project", "local"]);

class SettingsFileParseError extends Error {
	constructor(readonly filePath: string, readonly cause: unknown) {
		super(`Failed to parse settings file: ${filePath}`);
		this.name = "SettingsFileParseError";
	}
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function decodeSettingSources(value: unknown): SettingSource[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const decoded: SettingSource[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		if (!ALLOWED_SETTING_SOURCES.has(item)) return undefined;
		switch (item) {
			case "user":
			case "project":
			case "local":
				decoded.push(item);
				break;
			default:
				return undefined;
		}
	}
	return decoded;
}

function decodeProviderSettings(value: unknown): ProviderSettings {
	if (!isJsonRecord(value)) return {};

	const appendSystemPrompt =
		typeof value["appendSystemPrompt"] === "boolean" ? value["appendSystemPrompt"] : undefined;
	const settingSources = decodeSettingSources(value["settingSources"]);
	const strictMcpConfig = typeof value["strictMcpConfig"] === "boolean" ? value["strictMcpConfig"] : undefined;

	return {
		...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
		...(settingSources !== undefined ? { settingSources } : {}),
		...(strictMcpConfig !== undefined ? { strictMcpConfig } : {}),
	};
}

function extractProviderSettingsBlock(value: JsonRecord): unknown {
	return value["claudeAgentSdkProvider"] ?? value["claude-agent-sdk-provider"] ?? value["claudeAgentSdk"];
}

function logSettingsFallback(error: unknown): void {
	if (error instanceof SettingsFileParseError) {
		const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause ?? "unknown");
		console.warn(`[claude-agent-sdk] Ignoring provider settings at ${error.filePath}: ${causeMessage}`);
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`[claude-agent-sdk] Ignoring provider settings: ${message}`);
}

function readSettingsFile(filePath: string): Effect.Effect<ProviderSettings> {
	return Effect.gen(function* () {
		if (!existsSync(filePath)) return {};

		const raw = yield* Effect.try({
			try: () => readFileSync(filePath, "utf-8"),
			catch: (cause) => new SettingsFileParseError(filePath, cause),
		});
		const parsed = yield* Effect.try({
			try: () => {
				const parsedValue: unknown = JSON.parse(raw);
				return parsedValue;
			},
			catch: (cause) => new SettingsFileParseError(filePath, cause),
		});

		if (!isJsonRecord(parsed)) return {};
		return decodeProviderSettings(extractProviderSettingsBlock(parsed));
	}).pipe(
		Effect.catchAll((error) =>
			Effect.sync(() => {
				logSettingsFallback(error);
				return {};
			}),
		),
	);
}

export function loadProviderSettings(): ProviderSettings {
	const globalSettings = Effect.runSync(readSettingsFile(GLOBAL_SETTINGS_PATH));
	const projectSettings = Effect.runSync(readSettingsFile(PROJECT_SETTINGS_PATH));
	return { ...globalSettings, ...projectSettings };
}
