import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AgenticLoop = (pi: ExtensionAPI) => void;

export interface SubagentRunOptions {
  cwd: string;
  prompt: string;
  systemPrompt: string;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  tools?: string[];
  timeoutMs?: number;
}
