import type { ProviderRuntimeEvent, TurnId } from "@t3tools/contracts";
import { Schema } from "effect";

import type { DeepSeekSessionEvent } from "./DeepSeekHostProtocol.ts";
import { classifyDeepSeekTool } from "./DeepSeekToolClassification.ts";

type EventType = ProviderRuntimeEvent["type"];
type PayloadFor<T extends EventType> = Extract<
  ProviderRuntimeEvent,
  { readonly type: T }
>["payload"];

export type DeepSeekTranslatedEvent = {
  [T in EventType]: {
    readonly type: T;
    readonly payload: PayloadFor<T>;
    readonly turnId?: TurnId;
    readonly itemId?: string;
    readonly requestId?: string;
    readonly createdAtMs: number;
    readonly raw: DeepSeekSessionEvent;
  };
}[EventType];

const TurnData = Schema.Struct({ turn: Schema.Int });
const TurnEndData = Schema.Struct({
  turn: Schema.Int,
  reason: Schema.Struct({ kind: Schema.String }),
});
const SessionTitleData = Schema.Struct({ title: Schema.String });
const AssistantChunkData = Schema.Struct({
  turn: Schema.Int,
  step: Schema.Int,
  chunk: Schema.Record(Schema.String, Schema.Unknown),
});
const AssistantDeltaChunk = Schema.Struct({
  type: Schema.Literals(["reasoning-delta", "text-delta"]),
  index: Schema.Int,
  text: Schema.String,
});
const AssistantToolCallDeltaChunk = Schema.Struct({
  type: Schema.Literal("tool-call-delta"),
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  argumentsDelta: Schema.optionalKey(Schema.String),
});
const AssistantUsageChunk = Schema.Struct({
  type: Schema.Literal("usage"),
  usage: Schema.Struct({
    inputTokens: Schema.optionalKey(Schema.Number),
    outputTokens: Schema.optionalKey(Schema.Number),
  }),
});
const AssistantBlockEndChunk = Schema.Struct({
  type: Schema.Literal("block-end"),
  index: Schema.Int,
  block: Schema.Struct({ type: Schema.Literals(["reasoning", "text"]) }),
});
const AssistantChunk = Schema.Union([
  AssistantDeltaChunk,
  AssistantToolCallDeltaChunk,
  AssistantUsageChunk,
  AssistantBlockEndChunk,
]);
const ToolCallData = Schema.Struct({
  turn: Schema.Int,
  step: Schema.Int,
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});
const ToolResultData = Schema.Struct({
  turn: Schema.Int,
  step: Schema.Int,
  message: Schema.Unknown,
  error: Schema.optionalKey(Schema.Unknown),
});
const TodoWriteData = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      status: Schema.Literals(["pending", "in_progress", "completed"]),
    }),
  ),
});
const ToolResultMessage = Schema.Struct({
  source: Schema.Struct({ callId: Schema.String }),
});

const decodeTurn = Schema.decodeUnknownSync(TurnData);
const decodeTurnEnd = Schema.decodeUnknownSync(TurnEndData);
const decodeSessionTitle = Schema.decodeUnknownSync(SessionTitleData);
const decodeAssistantChunk = Schema.decodeUnknownSync(AssistantChunkData);
const decodeAssistantDeltaChunk = Schema.decodeUnknownSync(AssistantDeltaChunk);
const decodeAssistantToolCallDeltaChunk = Schema.decodeUnknownSync(AssistantToolCallDeltaChunk);
const decodeAssistantUsageChunk = Schema.decodeUnknownSync(AssistantUsageChunk);
const decodeAssistantBlockEndChunk = Schema.decodeUnknownSync(AssistantBlockEndChunk);
const decodeAssistantChunkVariant = Schema.decodeUnknownSync(AssistantChunk);
const decodeToolCall = Schema.decodeUnknownSync(ToolCallData);
const decodeToolResult = Schema.decodeUnknownSync(ToolResultData);
const decodeTodoWrite = Schema.decodeUnknownSync(TodoWriteData);
const decodeToolResultMessage = Schema.decodeUnknownSync(ToolResultMessage);

function turnState(reason: string): "completed" | "failed" | "interrupted" | "cancelled" {
  if (reason === "interrupted") return "interrupted";
  if (reason === "cancelled" || reason === "aborted") return "cancelled";
  if (reason === "error" || reason === "failed") return "failed";
  return "completed";
}

function toolItemType(name: string): "command_execution" | "file_change" | "dynamic_tool_call" {
  const kind = classifyDeepSeekTool(name);
  if (kind === "command") return "command_execution";
  if (kind === "fileChange") return "file_change";
  return "dynamic_tool_call";
}

function assistantBlockItemId(
  turn: number,
  step: number,
  index: number,
  blockType: "reasoning" | "text",
): string {
  return `deepseek-${turn}-${step}-${blockType}-${index}`;
}

export class DeepSeekEventTranslator {
  readonly #turnIds = new Map<number, TurnId>();
  readonly #startedItems = new Set<string>();
  readonly #toolNames = new Map<string, string>();
  #pendingTurnId: TurnId | undefined;
  #activeTurnId: TurnId | undefined;

  setPendingTurnId(turnId: TurnId): void {
    this.#pendingTurnId = turnId;
  }

  clearPendingTurnId(turnId: TurnId): void {
    if (this.#pendingTurnId === turnId) this.#pendingTurnId = undefined;
  }

  turnIdFor(turn: number): TurnId | undefined {
    return this.#turnIds.get(turn);
  }

  translate(event: DeepSeekSessionEvent): ReadonlyArray<DeepSeekTranslatedEvent> {
    switch (event.type) {
      case "turn/start": {
        const data = decodeTurn(event.data);
        const turnId = this.#pendingTurnId;
        if (turnId === undefined) return [];
        this.#pendingTurnId = undefined;
        this.#turnIds.set(data.turn, turnId);
        this.#activeTurnId = turnId;
        return [
          {
            type: "turn.started",
            payload: {},
            turnId,
            createdAtMs: event.time,
            raw: event,
          },
        ];
      }
      case "turn/end": {
        const data = decodeTurnEnd(event.data);
        const turnId = this.#turnIds.get(data.turn);
        if (turnId === undefined) return [];
        if (this.#activeTurnId === turnId) this.#activeTurnId = undefined;
        return [
          {
            type: "turn.completed",
            payload: { state: turnState(data.reason.kind), stopReason: data.reason.kind },
            turnId,
            createdAtMs: event.time,
            raw: event,
          },
        ];
      }
      case "session/title": {
        const data = decodeSessionTitle(event.data);
        const title = data.title.trim();
        return title
          ? [
              {
                type: "thread.metadata.updated",
                payload: { name: title },
                createdAtMs: event.time,
                raw: event,
              },
            ]
          : [];
      }
      case "assistant/chunk":
        return this.#translateAssistantChunk(event);
      case "tool/call":
        return this.#translateToolCall(event);
      case "tool/result":
        return this.#translateToolResult(event);
      case "todo/write": {
        const data = decodeTodoWrite(event.data);
        if (this.#activeTurnId === undefined) return [];
        return [
          {
            type: "turn.plan.updated",
            payload: {
              explanation: "DeepSeek Harness tasks",
              plan: data.todos.map((todo) => ({
                step: todo.content.trim() || "Task",
                status: todo.status === "in_progress" ? "inProgress" : todo.status,
              })),
            },
            turnId: this.#activeTurnId,
            createdAtMs: event.time,
            raw: event,
          },
        ];
      }
      default:
        return [];
    }
  }

  #translateAssistantChunk(event: DeepSeekSessionEvent): ReadonlyArray<DeepSeekTranslatedEvent> {
    const data = decodeAssistantChunk(event.data);
    const turnId = this.#turnIds.get(data.turn);
    if (turnId === undefined) return [];
    const chunk = decodeAssistantChunkVariant(data.chunk);
    const chunkType = chunk.type;

    if (chunkType === "reasoning-delta" || chunkType === "text-delta") {
      const decoded = decodeAssistantDeltaChunk(chunk);
      const blockType = decoded.type === "reasoning-delta" ? "reasoning" : "text";
      const itemId = assistantBlockItemId(data.turn, data.step, decoded.index, blockType);
      const itemType = blockType === "reasoning" ? "reasoning" : "assistant_message";
      const streamKind = blockType === "reasoning" ? "reasoning_text" : "assistant_text";
      const events: DeepSeekTranslatedEvent[] = [];
      if (!this.#startedItems.has(itemId)) {
        this.#startedItems.add(itemId);
        events.push({
          type: "item.started",
          payload: { itemType, status: "inProgress" },
          turnId,
          itemId,
          createdAtMs: event.time,
          raw: event,
        });
      }
      events.push({
        type: "content.delta",
        payload: { streamKind, delta: decoded.text },
        turnId,
        itemId,
        createdAtMs: event.time,
        raw: event,
      });
      return events;
    }

    if (chunkType === "tool-call-delta") {
      const decoded = decodeAssistantToolCallDeltaChunk(chunk);
      const callId = decoded.id;
      const name = decoded.name ?? "tool";
      this.#toolNames.set(callId, name);
      const argumentsDelta = decoded.argumentsDelta;
      const events: DeepSeekTranslatedEvent[] = [];
      if (!this.#startedItems.has(callId)) {
        this.#startedItems.add(callId);
        events.push({
          type: "item.started",
          payload: { itemType: toolItemType(name), status: "inProgress", title: name },
          turnId,
          itemId: callId,
          createdAtMs: event.time,
          raw: event,
        });
      }
      if (argumentsDelta !== undefined) {
        events.push({
          type: "item.updated",
          payload: {
            itemType: toolItemType(name),
            status: "inProgress",
            title: name,
            detail: argumentsDelta,
          },
          turnId,
          itemId: callId,
          createdAtMs: event.time,
          raw: event,
        });
      }
      return events;
    }

    if (chunkType === "usage") {
      const usage = decodeAssistantUsageChunk(chunk).usage;
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      return [
        {
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: inputTokens + outputTokens,
              totalProcessedTokens: inputTokens + outputTokens,
              inputTokens,
              outputTokens,
              lastUsedTokens: inputTokens + outputTokens,
              lastInputTokens: inputTokens,
              lastOutputTokens: outputTokens,
            },
          },
          turnId,
          createdAtMs: event.time,
          raw: event,
        },
      ];
    }

    if (chunkType === "block-end") {
      const decoded = decodeAssistantBlockEndChunk(chunk);
      const blockType = decoded.block.type;
      const itemId = assistantBlockItemId(data.turn, data.step, decoded.index, blockType);
      if (!this.#startedItems.delete(itemId)) return [];
      return [
        {
          type: "item.completed",
          payload: {
            itemType: blockType === "reasoning" ? "reasoning" : "assistant_message",
            status: "completed",
          },
          turnId,
          itemId,
          createdAtMs: event.time,
          raw: event,
        },
      ];
    }
    return [];
  }

  #translateToolCall(event: DeepSeekSessionEvent): ReadonlyArray<DeepSeekTranslatedEvent> {
    const data = decodeToolCall(event.data);
    const turnId = this.#turnIds.get(data.turn);
    if (turnId === undefined) return [];
    this.#toolNames.set(data.callId, data.name);
    if (this.#startedItems.has(data.callId)) {
      return [
        {
          type: "item.updated",
          payload: {
            itemType: toolItemType(data.name),
            status: "inProgress",
            title: data.name,
            detail: data.arguments,
          },
          turnId,
          itemId: data.callId,
          createdAtMs: event.time,
          raw: event,
        },
      ];
    }
    this.#startedItems.add(data.callId);
    return [
      {
        type: "item.started",
        payload: {
          itemType: toolItemType(data.name),
          status: "inProgress",
          title: data.name,
          detail: data.arguments,
        },
        turnId,
        itemId: data.callId,
        createdAtMs: event.time,
        raw: event,
      },
    ];
  }

  #translateToolResult(event: DeepSeekSessionEvent): ReadonlyArray<DeepSeekTranslatedEvent> {
    const data = decodeToolResult(event.data);
    const turnId = this.#turnIds.get(data.turn);
    if (turnId === undefined) return [];
    const message = data.message;
    const callId = decodeToolResultMessage(message).source.callId;
    const name = this.#toolNames.get(callId) ?? "tool";
    return [
      {
        type: "item.completed",
        payload: {
          itemType: toolItemType(name),
          status: data.error === undefined ? "completed" : "failed",
          title: name,
          data: message,
        },
        turnId,
        itemId: callId,
        createdAtMs: event.time,
        raw: event,
      },
    ];
  }
}
