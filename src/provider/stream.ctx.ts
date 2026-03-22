export type StreamTextBlock = { type: "text"; text: string; index?: number };

export type StreamThinkingBlock = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	index?: number;
};

export type StreamToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	partialJson?: string;
	index?: number;
};

export type StreamBlock = StreamTextBlock | StreamThinkingBlock | StreamToolCallBlock;

export function findBlockIndexByEventIndex(blocks: StreamBlock[], eventIndex: number): number {
	return blocks.findIndex((block) => block.index === eventIndex);
}
