/**
 * Кастомный инструмент "code_review_loop" для Pi SDK.
 * 
 * После каждой правки кода вызывает саб-агента на код-ревью.
 * Цикл: правка → ревью → фикс → повтор, пока не будет чисто.
 * 
 * Использование в session.prompt():
 *   await session.prompt("Сделай рефакторинг AuthModule и проверь качество кода")
 *   Агент сам решит вызвать этот инструмент после правок.
 */

import { Type } from "typebox";
import { createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";

// Системный промпт для ревьюера — он должен быть строгим и детализированным
const REVIEWER_SYSTEM_PROMPT = `Ты — старший code reviewer. Твоя задача:

1. Внимательно прочитать предоставленные файлы
2. Найти ВСЕ проблемы: баги, антипаттерны, уязвимости, плохие имена переменных
3. Описать каждую проблему конкретно (файл, строка, что не так)
4. Предложить конкретное исправление

Будь максимально придирчивым. Не пропускай ничего.`;

// Максимальное количество итераций цикла ревью
const MAX_REVIEW_ITERATIONS = 5;

export function createCodeReviewTool(options = {}) {
  const { maxIterations = MAX_REVIEW_ITERATIONS, cwd } = options;

  return defineTool({
    name: "code_review_loop",
    label: "Code Review Loop",
    description: `Запускает цикл код-ревью. Читает файлы, находит проблемы, возвращает findings. Вызывай ПОСЛЕ каждой правки кода. Максимум ${maxIterations} итераций.`,
    parameters: Type.Object({
      files: Type.Array(Type.String(), {
        description: "Список файлов для ревью (относительные пути)"
      }),
      task: Type.String({
        description: "Описание задачи, которую выполнял агент (контекст для ревьюера)"
      })
    }),
    execute: async (_toolCallId, params) => {
      const { files, task } = params;

      // Читаем все файлы для ревью
      const { read } = await import("node:fs");
      const fileContents = {};
      const missingFiles = [];

      for (const filePath of files) {
        try {
          const fullPath = cwd ? `${cwd}/${filePath}` : filePath;
          const content = read(fullPath, "utf-8");
          fileContents[filePath] = content;
        } catch {
          missingFiles.push(filePath);
        }
      }

      if (missingFiles.length > 0) {
        return {
          content: [{
            type: "text",
            text: `⚠️ Не удалось прочитать файлы: ${missingFiles.join(", ")}`
          }]
        };
      }

      // === ЦИКЛ РЕВЬЮ ===
      let iteration = 0;
      let findings = [];
      let allFindingsText = "";

      while (iteration < maxIterations) {
        iteration++;

        const session = await createAgentSession({
          cwd,
          systemPromptOverride: () => REVIEWER_SYSTEM_PROMPT,
          // Подключаем только read — ревьюеру не нужно писать/править файлы
          tools: ["read"],
          excludeTools: [],
        });

        // Формируем промпт для ревьюера
        let prompt = `Выполняю код-ревью.\n\nЗадача: ${task}\n\nФайлы для проверки:\n`;

        for (const [filePath, content] of Object.entries(fileContents)) {
          prompt += `\n--- ${filePath} ---\n${content}\n`;
        }

        // Добавляем предыдущие findings если есть
        if (allFindingsText) {
          prompt += `\n\n=== Предыдущие найденные проблемы ===\n${allFindingsText}`;
          prompt += `\n\nПроверь, были ли исправлены эти проблемы, и найди новые.`;
        }

        // Запускаем ревью
        await session.prompt(prompt);

        // Получаем результат ревью (последнее сообщение ассистента)
        const messages = session.agent.state.messages;
        const lastAssistantMsg = messages.find(
          m => m.role === "assistant" && m.content?.[0]?.type === "text"
        );

        if (!lastAssistantMsg || !lastAssistantMsg.content?.[0]?.text) {
          findings.push(`Итерация ${iteration}: ревью не вернуло результат`);
          allFindingsText += `\n- Итерация ${iteration}: ревью не вернуло результат`;
          continue;
        }

        const reviewResult = lastAssistantMsg.content[0].text;

        // Извлекаем findings (ищем строки с номерами проблем)
        const foundIssues = extractFindings(reviewResult);

        if (foundIssues.length === 0) {
          findings.push(`Итерация ${iteration}: ✅ Претензий нет, код чистый!`);
          allFindingsText += `\n- Итерация ${iteration}: ✅ Претензий нет`;
          break; // Всё чисто — выходим
        }

        findings.push(`Итерация ${iteration}: найдено ${foundIssues.length} проблем`);
        allFindingsText += `\n\n=== Итерация ${iteration} ===\n${reviewResult}`;
      }

      const result = {
        iterations,
        totalFindings: findings.length,
        summary: `Завершено за ${iteration} итераций. ${findings.join("; ")}`,
        details: allFindingsText
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  });
}

/**
 * Извлекает найденные проблемы из текста ревью.
 */
function extractFindings(text) {
  const issues = [];
  const lines = text.split("\n");

  for (const line of lines) {
    // Ищем паттерны типа "Файл: X, Строка: Y" или просто номера проблем
    if (/^(?:проблема|issue|bug|problem|file|строка|line)\s*[:.]/i.test(line.trim())) {
      issues.push(line.trim());
    }
  }

  return issues;
}
