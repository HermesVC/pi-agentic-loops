import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AgenticLoop = (pi: ExtensionAPI) => void;

export interface SubagentProgress {
  kind: "thinking" | "tool_start" | "tool_end" | "heartbeat";
  activity: string;
  toolName?: string;
  elapsedMs: number;
  isError?: boolean;
}

export interface SubagentRunOptions {
  cwd: string;
  prompt: string;
  systemPrompt: string;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  onProgress?: (progress: SubagentProgress) => void;
  heartbeatMs?: number;
  model?: string;
  tools?: string[];
  timeoutMs?: number;
}
