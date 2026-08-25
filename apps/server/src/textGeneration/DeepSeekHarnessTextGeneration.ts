import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TextGeneration } from "./TextGeneration.ts";

export const makeDeepSeekHarnessTextGeneration = Effect.sync(() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail:
          "DeepSeek Harness text generation is not enabled in the developer-preview MVP. Conversation title events still come from DeepSeek Harness itself.",
      }),
    );
  return TextGeneration.of({
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  });
});
