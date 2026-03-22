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
	const base = `[${error.code}] ${error.message}`;
	const messages = collectErrorMessages(error);
	const causeMessages = messages.filter((message) => message !== error.message);
	const hints = buildActionHints(messages);

	const lines = [base];
	if (causeMessages.length > 0) lines.push(`Cause: ${causeMessages.join(" | ")}`);
	for (const hint of hints) lines.push(hint);
	return lines.join("\n");
}
