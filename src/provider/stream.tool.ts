import type { DecodedSdkStreamEventMessage } from "./decoders.js";
import { findBlockIndexByEventIndex, type StreamBlock, type StreamToolCallBlock } from "./stream.ctx.js";

export type StreamToolEmission =
	| { type: "toolcall_start"; contentIndex: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: StreamToolCallBlock };

export type StreamToolDeps = {
	mapSdkToolNameToPi: (toolName: string) => string;
	mapToolArgs: (toolName: string, args: Record<string, unknown>) => Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try {
		const parsed: unknown = JSON.parse(input);
		return isRecord(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

export function applyStreamToolEvent(
	blocks: StreamBlock[],
	event: DecodedSdkStreamEventMessage,
	deps: StreamToolDeps,
): StreamToolEmission[] {
	switch (event.type) {
		case "content_block_start": {
			if (event.contentBlock.type !== "tool_use") return [];
			blocks.push({
				type: "toolCall",
				id: event.contentBlock.id,
				name: deps.mapSdkToolNameToPi(event.contentBlock.name),
				arguments: event.contentBlock.input,
				partialJson: "",
				index: event.index,
			});
			return [{ type: "toolcall_start", contentIndex: blocks.length - 1 }];
		}
		case "content_block_delta": {
			if (event.delta.type !== "input_json_delta") return [];
			const contentIndex = findBlockIndexByEventIndex(blocks, event.index);
			const block = blocks[contentIndex];
			if (!block || block.type !== "toolCall") return [];
			block.partialJson = `${block.partialJson ?? ""}${event.delta.partial_json}`;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			return [{ type: "toolcall_delta", contentIndex, delta: event.delta.partial_json }];
		}
		case "content_block_stop": {
			const contentIndex = findBlockIndexByEventIndex(blocks, event.index);
			const block = blocks[contentIndex];
			if (!block || block.type !== "toolCall") return [];
			delete block.index;
			block.arguments = deps.mapToolArgs(block.name, parsePartialJson(block.partialJson ?? "", block.arguments));
			delete block.partialJson;
			return [{ type: "toolcall_end", contentIndex, toolCall: block }];
		}
		default:
			return [];
	}
}
