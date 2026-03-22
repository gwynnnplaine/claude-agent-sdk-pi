import { calculateCost, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import type { DecodedSdkStreamEventMessage } from "./decoders.js";

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		default:
			return "stop";
	}
}

export function applyMessageStartUsage(
	model: Model<Api>,
	output: AssistantMessage,
	event: Extract<DecodedSdkStreamEventMessage, { type: "message_start" }>,
): void {
	output.usage.input = event.usage.input_tokens ?? 0;
	output.usage.output = event.usage.output_tokens ?? 0;
	output.usage.cacheRead = event.usage.cache_read_input_tokens ?? 0;
	output.usage.cacheWrite = event.usage.cache_creation_input_tokens ?? 0;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

export function applyMessageDeltaUsage(
	model: Model<Api>,
	output: AssistantMessage,
	event: Extract<DecodedSdkStreamEventMessage, { type: "message_delta" }>,
): void {
	output.stopReason = mapStopReason(event.stopReason);
	if (event.usage.input_tokens != null) output.usage.input = event.usage.input_tokens;
	if (event.usage.output_tokens != null) output.usage.output = event.usage.output_tokens;
	if (event.usage.cache_read_input_tokens != null) output.usage.cacheRead = event.usage.cache_read_input_tokens;
	if (event.usage.cache_creation_input_tokens != null) output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

export function applyMessageStopReason(output: AssistantMessage, sawToolCall: boolean): boolean {
	if (!sawToolCall) return false;
	output.stopReason = "toolUse";
	return true;
}

export function toDoneReason(stopReason: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" {
	return stopReason === "toolUse" ? "toolUse" : stopReason === "length" ? "length" : "stop";
}
