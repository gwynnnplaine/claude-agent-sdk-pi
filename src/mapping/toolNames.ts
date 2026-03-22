import { pascalCase } from "change-case";
import { MCP_TOOL_PREFIX } from "../core/constants.js";

export const SDK_TO_PI_TOOL_NAME: Readonly<Record<string, string>> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
};

export const PI_TO_SDK_TOOL_NAME: Readonly<Record<string, string>> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	glob: "Glob",
};

export const DEFAULT_TOOLS: ReadonlyArray<string> = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];

export const BUILTIN_TOOL_NAMES = new Set(Object.keys(PI_TO_SDK_TOOL_NAME));

export function mapPiToolNameToSdk(name?: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

export function mapSdkToolNameToPi(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) {
		return name.slice(MCP_TOOL_PREFIX.length);
	}
	return name;
}
