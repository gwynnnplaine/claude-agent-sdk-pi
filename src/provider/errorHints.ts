import type { ClaudeAgentSdkProviderError } from "../core/errors.js";

const AUTH_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
	/invalid api key/i,
	/please run \/login/i,
	/unauthorized/i,
	/401\b/i,
	/authentication/i,
	/not authenticated/i,
];

const PROCESS_EXIT_PATTERNS: ReadonlyArray<RegExp> = [/process exited with code\s+\d+/i, /exited with code\s+\d+/i];

const RATE_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
	/rate limit/i,
	/too many requests/i,
	/429\b/i,
	/quota/i,
	/credit balance is too low/i,
];

const NETWORK_PATTERNS: ReadonlyArray<RegExp> = [
	/enotfound/i,
	/econnrefused/i,
	/econnreset/i,
	/etimedout/i,
	/network/i,
	/tls/i,
	/certificate/i,
];

const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /sk-ant-[a-z0-9_-]+/gi, replacement: "[REDACTED_API_KEY]" },
	{ pattern: /(Bearer\s+)[a-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
	{ pattern: /(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, replacement: "$1[REDACTED]" },
	{ pattern: /(authorization\s*[:=]\s*)[^\n]+/gi, replacement: "$1[REDACTED]" },
];

const MAX_CAUSE_MESSAGE_CHARS = 300;
const MAX_VISIBLE_CAUSE_MESSAGES = 3;

function getMessage(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (value instanceof Error) {
		const trimmed = value.message.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const messageValue = Reflect.get(value, "message");
	if (typeof messageValue !== "string") return undefined;
	const trimmed = messageValue.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getCause(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	if (!("cause" in value)) return undefined;
	return Reflect.get(value, "cause");
}

function includesAnyPattern(text: string, patterns: ReadonlyArray<RegExp>): boolean {
	for (const pattern of patterns) {
		if (pattern.test(text)) return true;
	}
	return false;
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}...[truncated]`;
}

function redactSensitiveText(text: string): string {
	let redacted = text;
	for (const { pattern, replacement } of REDACTION_PATTERNS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

function sanitizeForOutput(text: string): string {
	const redacted = redactSensitiveText(text).trim();
	return truncateText(redacted, MAX_CAUSE_MESSAGE_CHARS);
}

function collectErrorMessages(error: unknown): string[] {
	const messages: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;

	for (let depth = 0; depth < 8; depth += 1) {
		if (current == null) break;
		if (seen.has(current)) break;
		seen.add(current);

		const message = getMessage(current);
		if (message && !messages.includes(message)) messages.push(message);

		current = getCause(current);
	}

	return messages;
}

function buildActionHints(messages: string[]): string[] {
	const joined = messages.join("\n");
	const hints: string[] = [];

	if (includesAnyPattern(joined, AUTH_FAILURE_PATTERNS)) {
		hints.push("Hint: auth failed. If using Claude Code login, unset ANTHROPIC_API_KEY then run /login again.");
	}
	if (includesAnyPattern(joined, PROCESS_EXIT_PATTERNS)) {
		hints.push("Hint: Claude Code subprocess exited. Run `npx @anthropic-ai/claude-code` in this shell, then /reload.");
	}
	if (includesAnyPattern(joined, RATE_LIMIT_PATTERNS)) {
		hints.push("Hint: rate-limited/quota. Wait or use an account with available API credits.");
	}
	if (includesAnyPattern(joined, NETWORK_PATTERNS)) {
		hints.push("Hint: network/TLS issue. Check proxy, VPN, DNS, and firewall settings.");
	}

	return hints;
}

export function formatProviderErrorMessage(error: ClaudeAgentSdkProviderError): string {
	const rawMessages = collectErrorMessages(error);
	const hints = buildActionHints(rawMessages);

	const baseMessage = sanitizeForOutput(error.message || "Unknown error");
	const base = `[${error.code}] ${baseMessage}`;

	const sanitizedMessages = rawMessages
		.map(sanitizeForOutput)
		.filter((message) => message.length > 0);
	const causeMessages = Array.from(new Set(sanitizedMessages.filter((message) => message !== baseMessage)));

	const lines = [base];
	if (causeMessages.length > 0) {
		const visible = causeMessages.slice(0, MAX_VISIBLE_CAUSE_MESSAGES);
		const hiddenCount = causeMessages.length - visible.length;
		const suffix = hiddenCount > 0 ? ` (+${hiddenCount} more)` : "";
		lines.push(`Cause: ${visible.join(" | ")}${suffix}`);
	}
	for (const hint of hints) lines.push(hint);
	return lines.join("\n");
}
