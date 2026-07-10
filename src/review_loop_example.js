/**
 * Пример: агентский цикл с код-ревью после каждой правки.
 * 
 * Сценарий:
 * 1. Агент получает задачу (например, "добавь валидацию email")
 * 2. Агент читает код, понимает структуру
 * 3. Агент вносит правки
 * 4. Агент вызывает code_review_loop → ревьюер находит проблемы
 * 5. Агент чинит найденные проблемы
 * 6. Повторяем пока ревью не будет чисто
 */

import { createAgentSession, defineTool, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import path from "node:path";

// === КОНФИГ РЕВЬЮЕРА ===
const REVIEWER_SYSTEM_PROMPT = `Ты — старший code reviewer с 10+ опытом. Твоя задача:

1. Внимательно прочитать предоставленные файлы
2. Найти ВСЕ проблемы: баги, антипаттерны, уязвимости, плохие имена
3. Описать каждую проблему конкретно (файл, строка, что не так)
4. Предложить конкретное исправление

Будь придирчивым. Не пропускай ничего.`;

// === КАСТОМНЫЙ ИНСТРУМЕНТ: code_review_loop ===
const codeReviewTool = defineTool({
  name: "code_review_loop",
  label: "🔍 Code Review Loop",
  description: `Запускает цикл код-ревью. Читает файлы, находит проблемы, возвращает findings. Вызывай ПОСЛЕ каждой правки кода. Максимум 5 итераций.`,
  parameters: Type.Object({
    files: Type.Array(Type.String(), {
      description: "Список файлов для ревью (относительные пути)"
    }),
    task: Type.String({
      description: "Описание задачи, которую выполнял агент"
    })
  }),
  execute: async (_toolCallId, params) => {
    const { files, task } = params;
    const cwd = process.cwd();

    console.log(`\n🔍 Запуск code_review_loop...`);
    console.log(`   Файлы: ${files.join(", ")}`);
    console.log(`   Задача: ${task}\n`);

    // Читаем файлы
    const fileContents = {};
    for (const filePath of files) {
      try {
        const fullPath = path.join(cwd, filePath);
        fileContents[filePath] = readFileSync(fullPath, "utf-8");
      } catch (e) {
        return {
          content: [{ type: "text", text: `⚠️ Не удалось прочитать ${filePath}: ${e.message}` }]
        };
      }
    }

    // === ЦИКЛ РЕВЬЮ ===
    let iteration = 0;
    const maxIterations = 5;
    let allFindingsText = "";

    while (iteration < maxIterations) {
      iteration++;
      console.log(`   📝 Итерация ревью #${iteration}...`);

      // Создаём сессию ревьюера с той же моделью
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      
      const reviewerResult = await createAgentSession({
        cwd,
        systemPromptOverride: () => REVIEWER_SYSTEM_PROMPT,
        tools: ["read"],  // ревьюеру только чтение
        authStorage,
        modelRegistry,
      });
      const reviewerSession = reviewerResult.session;

      // Формируем промпт
      let prompt = `Выполняю код-ревью.\n\nЗадача: ${task}\n\nФайлы:\n`;
      for (const [filePath, content] of Object.entries(fileContents)) {
        prompt += `\n--- ${filePath} ---\n${content}\n`;
      }

      // Добавляем предыдущие findings
      if (allFindingsText) {
        prompt += `\n\n=== Предыдущие проблемы ===\n${allFindingsText}`;
        prompt += `\n\nПроверь, были ли исправлены, и найди новые.`;
      }

      // Запускаем ревью
      await reviewerSession.prompt(prompt);

      // Получаем результат
      const messages = reviewerSession.agent.state.messages;
      const lastAssistantMsg = messages.find(
        m => m.role === "assistant" && m.content?.[0]?.type === "text"
      );

      if (!lastAssistantMsg) {
        allFindingsText += `\n- Итерация ${iteration}: ревью не вернуло результат`;
        continue;
      }

      const reviewResult = lastAssistantMsg.content[0].text;

      // Проверяем, есть ли претензии
      const hasIssues = /(?:проблем|баг|антипаттерн|уязвим|неправильн|ошибк|исправь|замечан|найдена|存在问题)/i.test(reviewResult);

      if (!hasIssues) {
        console.log(`   ✅ Итерация ${iteration}: код чистый!`);
        allFindingsText += `\n- Итерация ${iteration}: ✅ Претензий нет`;
        break;
      }

      console.log(`   ⚠️ Итерация ${iteration}: найдены проблемы`);
      allFindingsText += `\n\n=== Итерация ${iteration} ===\n${reviewResult}`;
    }

    const result = `Цикл завершён за ${iteration} итераций.\n\n${allFindingsText}`;

    console.log(`   ✅ Завершено: ${result.slice(0, 100)}...\n`);

    return {
      content: [{ type: "text", text: result }]
    };
  }
});

// === ГЛАВНЫЙ СКРИПТ ===
async function main() {
  console.log("🚀 Запуск агента с код-ревью циклом...\n");

  const { session } = await createAgentSession({
    customTools: [codeReviewTool],
    tools: ["read", "bash", "code_review_loop"],
  });

  // Подписка на события
  session.subscribe((event) => {
    if (event.type === "message_update" && 
        event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n🔧 ${event.toolName}`);
    }
    if (event.type === "turn_end") {
      console.log("\n━━━━━━━━━━━━━━━━━━");
    }
  });

  // Задача: агент сам сделает правки и проверит их через ревьюер
  await session.prompt(
    "Прочитай package.json. Добавь туда зависимости для express и dotenv. " +
    "После добавления вызови code_review_loop для проверки."
  );
}

main().catch(console.error);
