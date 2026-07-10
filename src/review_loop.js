/**
 * Агентский цикл с код-ревью.
 * 
 * Паттерн: правка → ревью → фикс → повтор (пока чисто)
 */

import { createAgentSession, defineTool, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

const MAX_ITERATIONS = 3; // макс. итераций ревью

// === Инструмент: code_review_loop ===
const codeReviewTool = defineTool({
  name: "code_review_loop",
  label: "🔍 Code Review Loop",
  description: `Запускает цикл код-ревью с саб-агентом. Читает файлы, находит проблемы, возвращает findings. Вызывай ПОСЛЕ каждой правки.`,
  parameters: Type.Object({
    files: Type.Array(Type.String(), { description: "Файлы для ревью" }),
    task: Type.String({ description: "Что делали / контекст задачи" })
  }),
  execute: async (_toolCallId, params) => {
    const { files, task } = params;
    console.log(`\n🔍 code_review_loop: ${files.join(", ")} | ${task}\n`);

    const cwd = process.cwd();
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    // Читаем файлы
    let prompt = `Код-ревью. Задача: ${task}\n\nФайлы:\n`;
    for (const f of files) {
      try {
        prompt += `--- ${f} ---\n${readFileSync(f, "utf-8")}\n`;
      } catch {
        prompt += `--- ${f} --- [НЕ НАЙДЕН]\n`;
      }
    }

    // Цикл ревью
    let iteration = 0;
    let allFindings = "";

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      
      const reviewer = await createAgentSession({
        cwd,
        systemPromptOverride: () => "Ты строгий code reviewer. Найди ВСЕ проблемы: баги, антипаттерны, уязвимости. Описывай конкретно.",
        tools: ["read"],
        authStorage,
        modelRegistry,
      });

      if (allFindings) {
        prompt += `\n\n=== Предыдущие проблемы ===\n${allFindings}`;
        prompt += `\nПроверь, исправлены ли они, и найди новые.`;
      }

      await reviewer.session.prompt(prompt);
      
      const msgs = reviewer.session.agent.state.messages;
      const lastMsg = msgs.find(m => m.role === "assistant" && m.content?.[0]?.type === "text");
      const result = lastMsg ? lastMsg.content[0].text : "[нет ответа]";

      // Проверяем есть ли проблемы
      const hasIssues = /(?:проблем|баг|антипаттерн|уязвим|исправь|замечан|неправильн)/i.test(result);
      
      if (!hasIssues) {
        console.log(`   ✅ Итерация ${iteration}: код чистый!`);
        allFindings = `Итерация ${iteration}: ✅ Претензий нет`;
        break;
      }

      console.log(`   ⚠️ Итерация ${iteration}: проблемы найдены`);
      allFindings += `\n\n=== Итерация ${iteration} ===\n${result}`;
    }

    return {
      content: [{ type: "text", text: `Результат ревью (${MAX_ITERATIONS} ит.): ${allFindings}` }]
    };
  }
});

// === Запуск ===
async function main() {
  console.log("🚀 Агент с код-ревью циклом\n");

  const { session } = await createAgentSession({
    customTools: [codeReviewTool],
    tools: ["read", "bash", "code_review_loop"],
  });

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n🔧 ${event.toolName}`);
    }
  });

  // Пример задачи: агент сам сделает правки + ревью
  await session.prompt(
    "Прочитай package.json. Добавь скрипт 'start'. " +
    "После этого вызови code_review_loop для проверки."
  );
}

main().catch(console.error);
