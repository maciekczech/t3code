export type DeepSeekToolKind = "command" | "fileChange" | "dynamic";

export function classifyDeepSeekTool(toolName: string): DeepSeekToolKind {
  if (toolName === "bash" || toolName === "shell" || toolName === "exec") return "command";
  if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
    return "fileChange";
  }
  return "dynamic";
}
