import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DeepSeekRpcError = Schema.Struct({
  code: NonEmptyString,
  message: Schema.String,
  details: Schema.optionalKey(Schema.Unknown),
});
export type DeepSeekRpcError = typeof DeepSeekRpcError.Type;

const DeepSeekRpcSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.optionalKey(Schema.Unknown),
});
const DeepSeekRpcFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error: DeepSeekRpcError,
});

export const DeepSeekServerResponse = Schema.Struct({
  type: Schema.Literal("server-response"),
  rpcId: NonEmptyString,
  result: Schema.Union([DeepSeekRpcSuccess, DeepSeekRpcFailure]),
});
export type DeepSeekServerResponse = typeof DeepSeekServerResponse.Type;

export const DeepSeekServerRequest = Schema.Struct({
  type: Schema.Literal("server-request"),
  rpcId: NonEmptyString,
  method: NonEmptyString,
  payload: Schema.Unknown,
});
export type DeepSeekServerRequest = typeof DeepSeekServerRequest.Type;

export const DeepSeekSessionEvent = Schema.Struct({
  type: NonEmptyString,
  seq: NonNegativeInt,
  time: Schema.Number,
  data: Schema.Unknown,
  sourceEventSeqs: Schema.optionalKey(Schema.Array(Schema.Number)),
  surfaceOp: Schema.optionalKey(Schema.Unknown),
  ignorable: Schema.optionalKey(Schema.Literal(true)),
});
export type DeepSeekSessionEvent = typeof DeepSeekSessionEvent.Type;

export const DeepSeekQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        description: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  multiSelect: Schema.optionalKey(Schema.Boolean),
  intent: Schema.optionalKey(Schema.Unknown),
});
export type DeepSeekQuestion = typeof DeepSeekQuestion.Type;

const DeepSeekToolView = Schema.Struct({
  for: Schema.Literals(["call", "result"]),
  view: Schema.Record(Schema.String, Schema.Unknown),
});

export const DeepSeekMuxFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session/event"),
    sessionId: NonEmptyString,
    event: DeepSeekSessionEvent,
    view: Schema.optionalKey(DeepSeekToolView),
  }),
  Schema.Struct({
    type: Schema.Literal("session/subscribed"),
    sessionId: NonEmptyString,
    lastSeq: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("approval/requested"),
    sessionId: NonEmptyString,
    approvalId: NonEmptyString,
    toolName: Schema.String,
    callId: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("approval/resolved"),
    sessionId: NonEmptyString,
    approvalId: NonEmptyString,
    outcome: Schema.Literals(["allowed-once", "rejected", "cancelled", "unavailable"]),
  }),
  Schema.Struct({
    type: Schema.Literal("question/requested"),
    sessionId: NonEmptyString,
    questions: Schema.Array(DeepSeekQuestion).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("question/resolved"),
    sessionId: NonEmptyString,
    questionRpcId: NonEmptyString,
    outcome: Schema.Literals(["answered", "cancelled"]),
  }),
  Schema.Struct({
    type: Schema.Literal("session/projection"),
    sessionId: NonEmptyString,
    key: NonEmptyString,
    value: Schema.Unknown,
    seq: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("session/queue"),
    sessionId: NonEmptyString,
    items: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("session/jobs"),
    sessionId: NonEmptyString,
    jobs: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("stream/error"), error: DeepSeekRpcError }),
]);
export type DeepSeekMuxFrame = typeof DeepSeekMuxFrame.Type;

export const DeepSeekHostFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("host/session-added"),
    sessionId: NonEmptyString,
    blank: Schema.Boolean,
    parentSessionId: Schema.optionalKey(NonEmptyString),
    origin: Schema.optionalKey(Schema.Literal("subagent")),
    cwd: Schema.optionalKey(Schema.String),
    agentPreset: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("host/session-removed"), sessionId: NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("host/session-status"),
    sessionId: NonEmptyString,
    running: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("host/agent-error"),
    sessionId: NonEmptyString,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("host/remote-event"),
    event: NonEmptyString,
    args: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("stream/error"), error: DeepSeekRpcError }),
]);
export type DeepSeekHostFrame = typeof DeepSeekHostFrame.Type;

export const DeepSeekSessionSummary = Schema.Struct({
  sessionId: NonEmptyString,
  updatedAt: Schema.Number,
  running: Schema.Boolean,
  blank: Schema.Boolean,
  parentSessionId: Schema.optionalKey(NonEmptyString),
  origin: Schema.optionalKey(Schema.Literal("subagent")),
  cwd: Schema.optionalKey(Schema.String),
  agentPreset: Schema.optionalKey(Schema.String),
  projections: Schema.optionalKey(Schema.Unknown),
});
export type DeepSeekSessionSummary = typeof DeepSeekSessionSummary.Type;

export const DeepSeekSessionListValue = Schema.Struct({
  items: Schema.Array(DeepSeekSessionSummary),
});
export const DeepSeekSessionCreateValue = Schema.Struct({
  sessionId: NonEmptyString,
  agentPreset: Schema.optionalKey(Schema.String),
});

export const DeepSeekHistoryEntry = Schema.Struct({
  event: DeepSeekSessionEvent,
  view: Schema.optionalKey(DeepSeekToolView),
});
export type DeepSeekHistoryEntry = typeof DeepSeekHistoryEntry.Type;
export const DeepSeekSessionHistoryValue = Schema.Struct({
  events: Schema.Array(DeepSeekHistoryEntry),
  hasMore: Schema.Boolean,
  projections: Schema.optionalKey(Schema.Unknown),
});

export const DeepSeekModelSelection = Schema.Struct({
  provider: NonEmptyString,
  model: NonEmptyString,
  reasoningEffort: Schema.optionalKey(NonEmptyString),
});
export type DeepSeekModelSelection = typeof DeepSeekModelSelection.Type;
export const DeepSeekSessionModelsValue = Schema.Struct({
  current: DeepSeekModelSelection,
  routable: Schema.Boolean,
  groups: Schema.Array(
    Schema.Struct({
      id: NonEmptyString,
      name: NonEmptyString,
      models: Schema.Array(
        Schema.Struct({
          id: NonEmptyString,
          name: NonEmptyString,
          description: Schema.optionalKey(Schema.String),
          reasoning: Schema.optionalKey(
            Schema.Struct({
              efforts: Schema.Array(
                Schema.Struct({
                  id: NonEmptyString,
                  name: NonEmptyString,
                  description: Schema.optionalKey(Schema.String),
                }),
              ),
              defaultEffort: Schema.optionalKey(NonEmptyString),
            }),
          ),
        }),
      ),
    }),
  ),
  failures: Schema.Array(
    Schema.Struct({ id: NonEmptyString, name: NonEmptyString, message: Schema.String }),
  ),
});
export type DeepSeekSessionModelsValue = typeof DeepSeekSessionModelsValue.Type;
export const DeepSeekLlmModelsValue = Schema.Struct({
  groups: DeepSeekSessionModelsValue.fields.groups,
  failures: DeepSeekSessionModelsValue.fields.failures,
});
export type DeepSeekLlmModelsValue = typeof DeepSeekLlmModelsValue.Type;

export const DeepSeekCredentialsDescribeValue = Schema.Struct({
  credentials: Schema.Record(
    Schema.String,
    Schema.Struct({
      configured: Schema.Boolean,
      source: Schema.optionalKey(Schema.String),
      writable: Schema.Boolean,
    }),
  ),
});
export type DeepSeekCredentialsDescribeValue = typeof DeepSeekCredentialsDescribeValue.Type;

export const DeepSeekSessionSelectModelValue = Schema.Struct({ selected: DeepSeekModelSelection });
export const DeepSeekAcceptedValue = Schema.Struct({ accepted: Schema.Literal(true) });
export const DeepSeekCommandValue = Schema.UndefinedOr(
  Schema.Struct({
    commandId: NonEmptyString,
    result: Schema.Struct({
      kind: Schema.Literals(["success", "error"]),
      text: Schema.optionalKey(Schema.String),
    }),
  }),
);
export const DeepSeekRpcReceipt = Schema.Union([
  Schema.Struct({ accepted: Schema.Literal(true) }),
  Schema.Struct({
    accepted: Schema.Literal(false),
    reason: Schema.Literals(["not-pending", "bad-response"]),
  }),
]);
