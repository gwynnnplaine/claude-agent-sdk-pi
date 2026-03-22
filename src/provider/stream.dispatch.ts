import type { DecodedSdkStreamEventMessage } from "./decoders.js";
import type { StreamBlock } from "./stream.ctx.js";
import { applyStreamTextEvent, type StreamTextEmission } from "./stream.text.js";
import { applyStreamThinkingEvent, type StreamThinkingEmission } from "./stream.thinking.js";
import { applyStreamToolEvent, type StreamToolDeps, type StreamToolEmission } from "./stream.tool.js";

export type StreamDispatchEmission = StreamTextEmission | StreamThinkingEmission | StreamToolEmission;

export type StreamDispatchResult = {
	handled: boolean;
	emissions: StreamDispatchEmission[];
};

type StreamContentEvent = Extract<
	DecodedSdkStreamEventMessage,
	{ type: "content_block_start" | "content_block_delta" | "content_block_stop" }
>;

type StreamContentHandler = (
	blocks: StreamBlock[],
	event: StreamContentEvent,
	toolDeps: StreamToolDeps,
) => StreamDispatchEmission[];

const streamContentHandlers: Record<StreamContentEvent["type"], StreamContentHandler> = {
	content_block_start: (blocks, event, toolDeps) => {
		return [
			...applyStreamTextEvent(blocks, event),
			...applyStreamThinkingEvent(blocks, event),
			...applyStreamToolEvent(blocks, event, toolDeps),
		];
	},
	content_block_delta: (blocks, event, toolDeps) => {
		return [
			...applyStreamTextEvent(blocks, event),
			...applyStreamThinkingEvent(blocks, event),
			...applyStreamToolEvent(blocks, event, toolDeps),
		];
	},
	content_block_stop: (blocks, event, toolDeps) => {
		return [
			...applyStreamTextEvent(blocks, event),
			...applyStreamThinkingEvent(blocks, event),
			...applyStreamToolEvent(blocks, event, toolDeps),
		];
	},
};

export function dispatchStreamContentEvent(
	blocks: StreamBlock[],
	event: DecodedSdkStreamEventMessage,
	toolDeps: StreamToolDeps,
): StreamDispatchResult {
	if (
		event.type !== "content_block_start" &&
		event.type !== "content_block_delta" &&
		event.type !== "content_block_stop"
	) {
		return { handled: false, emissions: [] };
	}
	return {
		handled: true,
		emissions: streamContentHandlers[event.type](blocks, event, toolDeps),
	};
}
