import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { SubagentRunOptions } from "./types.ts";

export async function runSubagent(options: SubagentRunOptions): Promise<string> {
  const startedAt = Date.now();
  let activity = "thinking";
  const progress = (kind: "thinking" | "tool_start" | "tool_end" | "heartbeat", toolName?: string, isError?: boolean) =>
    options.onProgress?.({ kind, activity, toolName, elapsedMs: Date.now() - startedAt, isError });
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const separator = options.model?.indexOf("/") ?? -1;
  const model = options.model
    ? modelRegistry.find(options.model.slice(0, separator), options.model.slice(separator + 1))
    : undefined;
  if (options.model && (separator < 1 || !model)) {
    throw new Error(`Verifier model is unavailable; expected provider/model, got: ${options.model}`);
  }
  const reviewer = await createAgentSession({
    cwd: options.cwd,
    systemPromptOverride: () => options.systemPrompt,
    tools: options.tools ?? ["read"],
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory(options.cwd),
  });

  const unsubscribe = reviewer.session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      activity = "thinking";
      options.onTextDelta?.(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      activity = event.toolName || "tool";
      progress("tool_start", event.toolName);
    } else if (event.type === "tool_execution_end") {
      progress("tool_end", event.toolName, event.isError);
      activity = "thinking";
    }
  });
  progress("thinking");
  const heartbeat = setInterval(() => progress("heartbeat"), options.heartbeatMs ?? 5_000);
  const timeout = options.timeoutMs
    ? setTimeout(() => void reviewer.session.abort(), options.timeoutMs)
    : undefined;

  try {
    options.signal?.throwIfAborted();
    await reviewer.session.prompt(options.prompt);
    options.signal?.throwIfAborted();

    const messages = reviewer.session.agent.state.messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as any;
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }

    return "[reviewer returned no text]";
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    reviewer.session.dispose();
  }
}
