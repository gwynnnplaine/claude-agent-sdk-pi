import type { DecodedSdkStreamEventMessage } from "./decoders.js";
import { findBlockIndexByEventIndex, type StreamBlock } from "./stream.ctx.js";

export type StreamThinkingEmission =
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string };

export function applyStreamThinkingEvent(
	blocks: StreamBlock[],
	event: DecodedSdkStreamEventMessage,
): StreamThinkingEmission[] {
	switch (event.type) {
		case "content_block_start": {
			if (event.contentBlock.type !== "thinking") return [];
			blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			return [{ type: "thinking_start", contentIndex: blocks.length - 1 }];
		}
		case "content_block_delta": {
			const contentIndex = findBlockIndexByEventIndex(blocks, event.index);
			const block = blocks[contentIndex];
			if (!block || block.type !== "thinking") return [];
			if (event.delta.type === "thinking_delta") {
				block.thinking += event.delta.thinking;
				return [{ type: "thinking_delta", contentIndex, delta: event.delta.thinking }];
			}
			if (event.delta.type === "signature_delta") {
				block.thinkingSignature = `${block.thinkingSignature ?? ""}${event.delta.signature}`;
			}
			return [];
		}
		case "content_block_stop": {
			const contentIndex = findBlockIndexByEventIndex(blocks, event.index);
			const block = blocks[contentIndex];
			if (!block || block.type !== "thinking") return [];
			delete block.index;
			return [{ type: "thinking_end", contentIndex, content: block.thinking }];
		}
		default:
			return [];
	}
}
