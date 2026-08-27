import * as NodeAssert from "node:assert/strict";

import { TurnId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import { DeepSeekEventTranslator } from "./DeepSeekEventTranslator.ts";

describe("DeepSeekEventTranslator", () => {
  it("maps a streamed reasoning block and usage onto one T3 turn", () => {
    const translator = new DeepSeekEventTranslator();
    const turnId = TurnId.make("turn-1");
    translator.setPendingTurnId(turnId);

    NodeAssert.equal(
      translator.translate({ type: "turn/start", seq: 1, time: 100, data: { turn: 1 } })[0]?.type,
      "turn.started",
    );
    const delta = translator.translate({
      type: "assistant/chunk",
      seq: 2,
      time: 101,
      data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "Think" } },
    });
    NodeAssert.deepEqual(
      delta.map((event) => event.type),
      ["item.started", "content.delta"],
    );
    NodeAssert.deepEqual(delta[1]?.payload, { streamKind: "reasoning_text", delta: "Think" });

    const usage = translator.translate({
      type: "assistant/chunk",
      seq: 3,
      time: 102,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
      },
    });
    NodeAssert.equal(usage[0]?.type, "thread.token-usage.updated");
    NodeAssert.equal(
      usage[0]?.type === "thread.token-usage.updated" ? usage[0].payload.usage.usedTokens : -1,
      14,
    );
  });

  it("uses distinct item ids for reasoning and text at the same chunk index", () => {
    const translator = new DeepSeekEventTranslator();
    translator.setPendingTurnId(TurnId.make("turn-1"));
    translator.translate({ type: "turn/start", seq: 1, time: 100, data: { turn: 1 } });
    const reasoning = translator.translate({
      type: "assistant/chunk",
      seq: 2,
      time: 101,
      data: { turn: 1, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "Why" } },
    });
    const text = translator.translate({
      type: "assistant/chunk",
      seq: 3,
      time: 102,
      data: { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "Answer" } },
    });
    NodeAssert.notEqual(reasoning[0]?.itemId, text[0]?.itemId);
  });

  it("completes a streamed block with the same item id used by its deltas", () => {
    const translator = new DeepSeekEventTranslator();
    translator.setPendingTurnId(TurnId.make("turn-1"));
    translator.translate({ type: "turn/start", seq: 1, time: 100, data: { turn: 1 } });
    const delta = translator.translate({
      type: "assistant/chunk",
      seq: 2,
      time: 101,
      data: { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "Answer" } },
    });
    const completed = translator.translate({
      type: "assistant/chunk",
      seq: 3,
      time: 102,
      data: { turn: 1, step: 0, chunk: { type: "block-end", index: 0, block: { type: "text" } } },
    });
    NodeAssert.equal(completed[0]?.type, "item.completed");
    NodeAssert.equal(completed[0]?.itemId, delta[0]?.itemId);
  });

  it("deduplicates tool starts across argument chunks and durable calls", () => {
    const translator = new DeepSeekEventTranslator();
    translator.setPendingTurnId(TurnId.make("turn-1"));
    translator.translate({ type: "turn/start", seq: 1, time: 100, data: { turn: 1 } });
    const chunk = translator.translate({
      type: "assistant/chunk",
      seq: 2,
      time: 101,
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: "tool-call-delta",
          index: 1,
          id: "call-1",
          name: "bash",
          argumentsDelta: "{}",
        },
      },
    });
    const durable = translator.translate({
      type: "tool/call",
      seq: 3,
      time: 102,
      data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: "{}" },
    });
    NodeAssert.deepEqual(
      chunk.map((event) => event.type),
      ["item.started", "item.updated"],
    );
    NodeAssert.deepEqual(
      durable.map((event) => event.type),
      ["item.updated"],
    );
  });

  it("maps interrupted turn end without inventing success", () => {
    const translator = new DeepSeekEventTranslator();
    translator.setPendingTurnId(TurnId.make("turn-1"));
    translator.translate({ type: "turn/start", seq: 1, time: 100, data: { turn: 1 } });
    const translated = translator.translate({
      type: "turn/end",
      seq: 2,
      time: 101,
      data: { turn: 1, reason: { kind: "interrupted" } },
    });
    NodeAssert.deepEqual(translated[0]?.payload, {
      state: "interrupted",
      stopReason: "interrupted",
    });
  });

  it("rejects malformed data for a known event", () => {
    const translator = new DeepSeekEventTranslator();
    translator.setPendingTurnId(TurnId.make("turn-1"));
    NodeAssert.throws(() =>
      translator.translate({ type: "turn/start", seq: 1, time: 100, data: { turn: "one" } }),
    );
  });

  it("maps the durable todo snapshot to the active T3 plan", () => {
    const translator = new DeepSeekEventTranslator();
    translator.setPendingTurnId(TurnId.make("turn-1"));
    translator.translate({ type: "turn/start", seq: 1, time: 100, data: { turn: 1 } });
    const translated = translator.translate({
      type: "todo/write",
      seq: 2,
      time: 101,
      data: {
        todos: [
          { content: "Inspect", status: "completed" },
          { content: "Implement", status: "in_progress" },
        ],
      },
    });
    NodeAssert.deepEqual(translated[0]?.payload, {
      explanation: "DeepSeek Harness tasks",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
      ],
    });
  });
});
