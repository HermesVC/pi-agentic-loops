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
  let streamedText = "";
  let timedOut = false;
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
    thinkingLevel: options.thinkingLevel,
    sessionManager: SessionManager.inMemory(options.cwd),
  });

  const unsubscribe = reviewer.session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      activity = "thinking";
      streamedText += event.assistantMessageEvent.delta;
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
    ? setTimeout(() => {
        timedOut = true;
        void reviewer.session.abort();
      }, options.timeoutMs)
    : undefined;

  try {
    options.signal?.throwIfAborted();
    await reviewer.session.prompt(options.prompt);
    options.signal?.throwIfAborted();
    if (timedOut) throw new Error(`Subagent timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} seconds`);

    const messages = reviewer.session.agent.state.messages;
    let lastAssistant: any;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as any;
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      lastAssistant ??= message;
      const text = message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }

    if (streamedText.trim()) return streamedText.trim();
    const stopReason = lastAssistant?.stopReason ?? "missing-assistant-message";
    const modelName = lastAssistant?.model ?? options.model ?? "default model";
    const contentTypes = Array.isArray(lastAssistant?.content)
      ? lastAssistant.content.map((part: any) => part.type).join(", ") || "empty"
      : "none";
    const providerError = lastAssistant?.errorMessage ? `: ${lastAssistant.errorMessage}` : "";
    throw new Error(`Subagent returned no final text (${modelName}, stop=${stopReason}, content=${contentTypes})${providerError}`);
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    reviewer.session.dispose();
  }
}
