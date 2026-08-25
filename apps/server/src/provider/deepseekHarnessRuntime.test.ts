import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  DeepSeekHarnessRuntimeError,
  parseDeepSeekHarnessReadyUrl,
  parseDeepSeekHarnessVersion,
  resolveDeepSeekHarnessLaunchArgs,
} from "./deepseekHarnessRuntime.ts";

describe("DeepSeekHarnessRuntime parsers", () => {
  it("parses the supported version output", () => {
    NodeAssert.equal(parseDeepSeekHarnessVersion("dsh 0.1.1-rc.2\n"), "0.1.1-rc.2");
    NodeAssert.equal(parseDeepSeekHarnessVersion("unexpected"), null);
  });

  it("accepts only the loopback readiness line", () => {
    NodeAssert.equal(
      parseDeepSeekHarnessReadyUrl("booting\ndsh web: http://127.0.0.1:38123\n"),
      "http://127.0.0.1:38123/",
    );
    NodeAssert.equal(parseDeepSeekHarnessReadyUrl("dsh web: http://0.0.0.0:38123\n"), null);
  });

  it("tokenizes additional launch arguments", () => {
    NodeAssert.deepEqual(resolveDeepSeekHarnessLaunchArgs('--profile "T3 profile"'), [
      "--profile",
      "T3 profile",
    ]);
  });

  it("rejects T3-owned network and browser flags", () => {
    for (const input of ["--host 0.0.0.0", "--port=3080", "--open", "--no-open"]) {
      NodeAssert.throws(() => resolveDeepSeekHarnessLaunchArgs(input), DeepSeekHarnessRuntimeError);
    }
  });
});
