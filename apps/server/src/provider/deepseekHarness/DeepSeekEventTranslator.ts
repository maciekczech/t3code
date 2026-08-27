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

const decodeTurn = Schema.decodeUnknownSync(TurnData);
const decodeTurnEnd = Schema.decodeUnknownSync(TurnEndData);
const decodeSessionTitle = Schema.decodeUnknownSync(SessionTitleData);
const decodeAssistantChunk = Schema.decodeUnknownSync(AssistantChunkData);
const decodeToolCall = Schema.decodeUnknownSync(ToolCallData);
const decodeToolResult = Schema.decodeUnknownSync(ToolResultData);
const decodeTodoWrite = Schema.decodeUnknownSync(TodoWriteData);

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

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
    const chunk = data.chunk;
    const chunkType = readString(chunk, "type");
    const index = readNumber(chunk, "index");
    const itemId =
      index === undefined || chunkType === undefined
        ? undefined
        : `deepseek-${data.turn}-${data.step}-${chunkType}-${index}`;

    if (chunkType === "reasoning-delta" || chunkType === "text-delta") {
      const text = readString(chunk, "text");
      if (text === undefined || itemId === undefined) return [];
      const itemType = chunkType === "reasoning-delta" ? "reasoning" : "assistant_message";
      const streamKind = chunkType === "reasoning-delta" ? "reasoning_text" : "assistant_text";
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
        payload: { streamKind, delta: text },
        turnId,
        itemId,
        createdAtMs: event.time,
        raw: event,
      });
      return events;
    }

    if (chunkType === "tool-call-delta") {
      const callId = readString(chunk, "id");
      const name = readString(chunk, "name") ?? "tool";
      if (callId === undefined) return [];
      this.#toolNames.set(callId, name);
      const argumentsDelta = readString(chunk, "argumentsDelta");
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
      const usage = chunk.usage;
      if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return [];
      const inputTokens = readNumber(usage as Record<string, unknown>, "inputTokens") ?? 0;
      const outputTokens = readNumber(usage as Record<string, unknown>, "outputTokens") ?? 0;
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

    if (chunkType === "block-end" && itemId !== undefined && this.#startedItems.has(itemId)) {
      const block = chunk.block;
      if (block === null || typeof block !== "object" || Array.isArray(block)) return [];
      const blockType = readString(block as Record<string, unknown>, "type");
      if (blockType !== "reasoning" && blockType !== "text") return [];
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
    if (message === null || typeof message !== "object" || Array.isArray(message)) return [];
    const source = (message as Record<string, unknown>).source;
    if (source === null || typeof source !== "object" || Array.isArray(source)) return [];
    const callId = readString(source as Record<string, unknown>, "callId");
    if (callId === undefined) return [];
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
