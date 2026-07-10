/**
 * Extension: code_review_loop
 * 
 * Агентский цикл с код-ревью. Вызови после каждой правки — 
 * саб-агент проверит код и вернёт findings.
 * 
 * Usage: code_review_loop(files: string[], task: string)
 */

import { createAgentSession, defineTool, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

const MAX_ITERATIONS = 3;

export default function (pi: any) {
  pi.registerTool({
    name: "code_review_loop",
    label: "🔍 Code Review Loop",
    description: `Запускает цикл код-ревью с саб-агентом. Читает файлы, находит проблемы, возвращает findings. Вызывай ПОСЛЕ каждой правки.`,
    parameters: Type.Object({
      files: Type.Array(Type.String(), { description: "Файлы для ревью" }),
      task: Type.String({ description: "Что делали / контекст задачи" })
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const { files, task } = params;
      
      console.log(`\n🔍 code_review_loop: ${files.join(", ")} | ${task}\n`);

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
        
        const authStorage = AuthStorage.create();
        const modelRegistry = ModelRegistry.create(authStorage);

        const reviewer = await createAgentSession({
          cwd: process.cwd(),
          systemPromptOverride: () => 
            "Ты строгий code reviewer. Найди ВСЕ проблемы: баги, антипаттерны, уязвимости, ошибки логики. " +
            "Описывай конкретно: что не так и как исправить. Если всё чисто — скажи '✅ Претензий нет'.",
          tools: ["read"],
          authStorage,
          modelRegistry,
        });

        // Обновляем промпт если это не первая итерация
        if (allFindings) {
          prompt += `\n\n=== Предыдущие проблемы ===\n${allFindings}`;
          prompt += `\nПроверь, исправлены ли они, и найди новые.`;
        }

        // Подписка на стриминг
        reviewer.session.subscribe((event: any) => {
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            onUpdate?.({ content: [{ type: "text", text: event.assistantMessageEvent.delta }] });
          }
        });

        await reviewer.session.prompt(prompt);
        
        const msgs = reviewer.session.agent.state.messages;
        const lastMsg = msgs.find((m: any) => m.role === "assistant" && m.content?.[0]?.type === "text");
        const result = lastMsg ? lastMsg.content[0].text : "[нет ответа]";

        // Проверяем есть ли проблемы
        const hasIssues = /(?:проблем|баг|антипаттерн|уязвим|исправь|замечан|неправильн|fix|issue|bug|warning)/i.test(result);
        
        if (!hasIssues) {
          console.log(`   ✅ Итерация ${iteration}: код чистый!`);
          allFindings = `Итерация ${iteration}: ✅ Претензий нет`;
          break;
        }

        console.log(`   ⚠️ Итерация ${iteration}: проблемы найдены`);
        allFindings += `\n\n=== Итерация ${iteration} ===\n${result}`;
      }

      return {
        content: [{ type: "text", text: `Результат ревью (${MAX_ITERATIONS} ит.):\n\n${allFindings}` }]
      };
    },
  });
}
