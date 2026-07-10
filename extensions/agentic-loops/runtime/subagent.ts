import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { SubagentRunOptions } from "./types.ts";

export async function runSubagent(options: SubagentRunOptions): Promise<string> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const reviewer = await createAgentSession({
    cwd: options.cwd,
    systemPromptOverride: () => options.systemPrompt,
    tools: options.tools ?? ["read"],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(options.cwd),
  });

  const unsubscribe = reviewer.session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      options.onTextDelta?.(event.assistantMessageEvent.delta);
    }
  });
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
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    reviewer.session.dispose();
  }
}
