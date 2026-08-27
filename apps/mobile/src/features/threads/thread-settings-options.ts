import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export type RuntimeModeChoice = {
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
};

export const RUNTIME_MODE_CHOICES: ReadonlyArray<RuntimeModeChoice> = [
  {
    mode: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    mode: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    mode: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

export function runtimeModeChoicesForProvider(
  providerDriver: string | undefined,
): ReadonlyArray<RuntimeModeChoice> {
  if (providerDriver !== "deepseekHarness") return RUNTIME_MODE_CHOICES;
  return RUNTIME_MODE_CHOICES.map((choice) =>
    choice.mode === "auto-accept-edits"
      ? {
          ...choice,
          description: "Allow workspace edits and routine workspace commands; ask to escalate.",
        }
      : choice,
  );
}

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}
