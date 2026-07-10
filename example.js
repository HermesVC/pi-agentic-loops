// Пример использования Pi SDK с локальной моделью (llama.cpp, порт 8081)
import { createAgentSession } from "@earendil-works/pi-coding-agent";

async function main() {
  console.log("🚀 Запуск Pi Agent Session...\n");

  const { session } = await createAgentSession();

  // Подписка на события (streaming вывод)
  session.subscribe((event) => {
    if (event.type === "message_update" && 
        event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n🔧 Tool: ${event.toolName}`);
    }
    if (event.type === "turn_end") {
      console.log("\n✅ Turn finished\n");
    }
  });

  // Отправляем промпт
  await session.prompt("Привет! Кто ты? Напиши краткий ответ.");
}

main().catch(console.error);
