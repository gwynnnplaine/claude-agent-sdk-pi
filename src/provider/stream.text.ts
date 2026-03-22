import type { DecodedSdkStreamEventMessage } from "./decoders.js";
import { findBlockIndexByEventIndex, type StreamBlock } from "./stream.ctx.js";

export type StreamTextEmission =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string };

export function applyStreamTextEvent(blocks: StreamBlock[], event: DecodedSdkStreamEventMessage): StreamTextEmission[] {
	switch (event.type) {
		case "content_block_start": {
			if (event.contentBlock.type !== "text") return [];
			blocks.push({ type: "text", text: "", index: event.index });
			return [{ type: "text_start", contentIndex: blocks.length - 1 }];
		}
		case "content_block_delta": {
			if (event.delta.type !== "text_delta") return [];
			const contentIndex = findBlockIndexByEventIndex(blocks, event.index);
			const block = blocks[contentIndex];
			if (!block || block.type !== "text") return [];
			block.text += event.delta.text;
			return [{ type: "text_delta", contentIndex, delta: event.delta.text }];
		}
		case "content_block_stop": {
			const contentIndex = findBlockIndexByEventIndex(blocks, event.index);
			const block = blocks[contentIndex];
			if (!block || block.type !== "text") return [];
			delete block.index;
			return [{ type: "text_end", contentIndex, content: block.text }];
		}
		default:
			return [];
	}
}
