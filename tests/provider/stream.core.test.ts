import test from "node:test";
import assert from "node:assert/strict";
import type { DecodedSdkStreamEventMessage } from "../../src/provider/decoders.js";
import { dispatchStreamContentEvent } from "../../src/provider/stream.dispatch.js";
import type { StreamBlock } from "../../src/provider/stream.ctx.js";
import { applyStreamTextEvent } from "../../src/provider/stream.text.js";
import { applyStreamToolEvent } from "../../src/provider/stream.tool.js";

test("applyStreamTextEvent emits start/delta/end and updates text block", () => {
	const blocks: StreamBlock[] = [];

	const startEvent: DecodedSdkStreamEventMessage = {
		type: "content_block_start",
		index: 0,
		contentBlock: { type: "text" },
	};
	const startEvents = applyStreamTextEvent(blocks, startEvent);
	assert.deepEqual(startEvents, [{ type: "text_start", contentIndex: 0 }]);

	const deltaEvent: DecodedSdkStreamEventMessage = {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "hello" },
	};
	const deltaEvents = applyStreamTextEvent(blocks, deltaEvent);
	assert.deepEqual(deltaEvents, [{ type: "text_delta", contentIndex: 0, delta: "hello" }]);

	const endEvent: DecodedSdkStreamEventMessage = {
		type: "content_block_stop",
		index: 0,
	};
	const endEvents = applyStreamTextEvent(blocks, endEvent);
	assert.deepEqual(endEvents, [{ type: "text_end", contentIndex: 0, content: "hello" }]);
});

test("applyStreamToolEvent emits start/delta/end and maps tool args", () => {
	const blocks: StreamBlock[] = [];
	const capturedArgs: Array<Record<string, unknown>> = [];

	const startEvent: DecodedSdkStreamEventMessage = {
		type: "content_block_start",
		index: 1,
		contentBlock: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
	};
	const startEvents = applyStreamToolEvent(blocks, startEvent, {
		mapSdkToolNameToPi: (toolName: string) => toolName.toLowerCase(),
		mapToolArgs: (_toolName: string, args: Record<string, unknown>) => {
			capturedArgs.push(args);
			return { path: String(args.file_path ?? "") };
		},
	});
	assert.deepEqual(startEvents, [{ type: "toolcall_start", contentIndex: 0 }]);

	const deltaEvent: DecodedSdkStreamEventMessage = {
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/a.txt"}' },
	};
	const deltaEvents = applyStreamToolEvent(blocks, deltaEvent, {
		mapSdkToolNameToPi: (toolName: string) => toolName.toLowerCase(),
		mapToolArgs: (_toolName: string, args: Record<string, unknown>) => args,
	});
	assert.deepEqual(deltaEvents, [{ type: "toolcall_delta", contentIndex: 0, delta: '{"file_path":"/tmp/a.txt"}' }]);

	const endEvent: DecodedSdkStreamEventMessage = {
		type: "content_block_stop",
		index: 1,
	};
	const endEvents = applyStreamToolEvent(blocks, endEvent, {
		mapSdkToolNameToPi: (toolName: string) => toolName.toLowerCase(),
		mapToolArgs: (_toolName: string, args: Record<string, unknown>) => {
			capturedArgs.push(args);
			return { path: String(args.file_path ?? "") };
		},
	});
	assert.deepEqual(endEvents, [
		{
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/a.txt" } },
		},
	]);
	assert.deepEqual(capturedArgs, [{ file_path: "/tmp/a.txt" }]);
});

test("dispatchStreamContentEvent routes content events through strategy handlers", () => {
	const blocks: StreamBlock[] = [];
	const startEvent: DecodedSdkStreamEventMessage = {
		type: "content_block_start",
		index: 2,
		contentBlock: { type: "text" },
	};
	const start = dispatchStreamContentEvent(blocks, startEvent, {
		mapSdkToolNameToPi: (toolName: string) => toolName,
		mapToolArgs: (_toolName: string, args: Record<string, unknown>) => args,
	});
	assert.equal(start.handled, true);
	assert.deepEqual(start.emissions, [{ type: "text_start", contentIndex: 0 }]);
});
