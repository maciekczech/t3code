import * as NodeAssert from "node:assert/strict";

import { Schema } from "effect";
import { describe, it } from "vite-plus/test";

import {
  DeepSeekMuxFrame,
  DeepSeekServerResponse,
  DeepSeekSessionModelsValue,
} from "./DeepSeekHostProtocol.ts";

describe("DeepSeek Host protocol", () => {
  it("decodes a successful RPC response and strips unknown fields", () => {
    const decoded = Schema.decodeUnknownSync(DeepSeekServerResponse)({
      type: "server-response",
      rpcId: "rpc-1",
      result: { ok: true, value: { accepted: true } },
      future: "ignored",
    });
    NodeAssert.equal(decoded.rpcId, "rpc-1");
    NodeAssert.deepEqual(decoded.result, { ok: true, value: { accepted: true } });
  });

  it("rejects malformed known mux frames", () => {
    NodeAssert.throws(() =>
      Schema.decodeUnknownSync(DeepSeekMuxFrame)({
        type: "session/event",
        sessionId: "session-1",
        event: { type: "turn/start", seq: -1, time: 1, data: { turn: 1 } },
      }),
    );
  });

  it("decodes models and reasoning effort metadata", () => {
    const decoded = Schema.decodeUnknownSync(DeepSeekSessionModelsValue)({
      current: { provider: "deepseek", model: "deepseek-v4", reasoningEffort: "high" },
      routable: true,
      groups: [
        {
          id: "deepseek",
          name: "DeepSeek",
          models: [
            {
              id: "deepseek-v4",
              name: "DeepSeek V4",
              reasoning: {
                efforts: [
                  { id: "off", name: "Off" },
                  { id: "high", name: "High", description: "More deliberate" },
                ],
                defaultEffort: "high",
              },
            },
          ],
        },
      ],
      failures: [],
    });
    NodeAssert.equal(decoded.groups[0]?.models[0]?.reasoning?.defaultEffort, "high");
  });
});
