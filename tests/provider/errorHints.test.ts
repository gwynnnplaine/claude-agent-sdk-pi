import test from "node:test";
import assert from "node:assert/strict";
import { toProviderError } from "../../src/core/errors.js";
import { formatProviderErrorMessage } from "../../src/provider/errorHints.js";

test("formatProviderErrorMessage includes auth/process hints and cause", () => {
	const cause = new Error("Invalid API key · Please run /login");
	const providerError = toProviderError(new Error("Claude Code process exited with code 1", { cause }), "stream_error");
	const message = formatProviderErrorMessage(providerError);

	assert.ok(message.includes("[stream_error] Claude Code process exited with code 1"));
	assert.ok(message.includes("Cause: Invalid API key · Please run /login"));
	assert.ok(message.includes("unset ANTHROPIC_API_KEY"));
	assert.ok(message.includes("subprocess exited"));
});

test("formatProviderErrorMessage includes network hint", () => {
	const providerError = toProviderError(
		new Error("request failed: getaddrinfo ENOTFOUND api.anthropic.com"),
		"stream_error",
	);
	const message = formatProviderErrorMessage(providerError);

	assert.ok(message.includes("Hint: network/TLS issue"));
});

test("formatProviderErrorMessage keeps simple message unchanged when no hints", () => {
	const providerError = toProviderError(new Error("boom"), "stream_error");
	const message = formatProviderErrorMessage(providerError);
	assert.equal(message, "[stream_error] boom");
});

test("formatProviderErrorMessage redacts secret-like tokens in cause chain", () => {
	const cause = new Error("Authorization: Bearer secret-token api_key=sk-ant-abc123xyz");
	const providerError = toProviderError(new Error("request failed", { cause }), "stream_error");
	const message = formatProviderErrorMessage(providerError);

	assert.ok(message.includes("Authorization: [REDACTED]"));
	assert.equal(message.includes("secret-token"), false);
	assert.equal(message.includes("sk-ant-abc123xyz"), false);
});
