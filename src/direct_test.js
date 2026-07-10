import { createAgentSession, defineTool, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

// Простой инструмент ревью
const reviewTool = defineTool({
  name: "review_code",
  label: "🔍 Review Code",
  description: "Читает файлы и проводит код-ревью. Вызывай после каждой правки.",
  parameters: Type.Object({
    files: Type.Array(Type.String(), { description: "Файлы для ревью" }),
    task: Type.String({ description: "Что делали" })
  }),
  execute: async (_toolCallId, params) => {
    const { files, task } = params;
    console.log(`\n🔍 Ревью: ${files.join(", ")} | Задача: ${task}\n`);

    // Создаём сессию ревьюера
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    const reviewer = await createAgentSession({
      cwd: process.cwd(),
      systemPromptOverride: () => "Ты строгий code reviewer. Найди ВСЕ проблемы в коде.",
      tools: ["read"],
      authStorage,
      modelRegistry,
    });

    console.log("   Сессия ревьюера создана:", typeof reviewer.session?.prompt === "function" ? "OK" : "FAIL");

    // Читаем файлы и строим промпт
    let prompt = `Код-ревью. Задача: ${task}\n\n`;
    for (const f of files) {
      try {
        const content = readFileSync(f, "utf-8");
        prompt += `--- ${f} ---\n${content}\n`;
      } catch(e) {
        prompt += `--- ${f} --- [НЕ НАЙДЕН]\n`;
      }
    }

    // Запускаем ревьюер
    reviewer.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    await reviewer.session.prompt(prompt);
    
    const messages = reviewer.session.agent.state.messages;
    const lastMsg = messages.find(m => m.role === "assistant" && m.content?.[0]?.type === "text");
    const result = lastMsg ? lastMsg.content[0].text : "[нет результата]";

    console.log("\n   ✅ Ревью завершено\n");
    
    return {
      content: [{ type: "text", text: `Результат ревью:\n${result}` }]
    };
  }
});

// Главный агент
const mainSession = await createAgentSession({
  customTools: [reviewTool],
  tools: ["read", "bash", "review_code"],
});

mainSession.session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
  if (event.type === "tool_execution_start") {
    console.log(`\n🔧 ${event.toolName}`);
  }
});

await mainSession.session.prompt("Прочитай package.json. Вызови review_code для проверки.");
