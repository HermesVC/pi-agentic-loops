// Пример с инструментами: чтение файлов + bash
import { createAgentSession } from "@earendil-works/pi-coding-agent";

async function main() {
  console.log("🚀 Запуск Pi Agent Session с инструментами...\n");

  const { session } = await createAgentSession({
    // Включаем конкретные инструменты
    tools: ["read", "bash"],
  });

  session.subscribe((event) => {
    if (event.type === "message_update" && 
        event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n🔧 Tool: ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      if (event.isError) {
        console.log(`   ❌ Error`);
      } else {
        console.log(`   ✅ Done`);
      }
    }
    if (event.type === "turn_end") {
      console.log("\n━━━━━━━━━━━━━━━━━━\n");
    }
  });

  // Задача: посмотреть что в текущей директории и написать коротко
  await session.prompt("Сделай ls -la /tmp/pi-setup/ и напиши что там есть, коротко.");
}

main().catch(console.error);
