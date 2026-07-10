import { createAgentSession, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const result = await createAgentSession({
  authStorage,
  modelRegistry,
});

console.log("Keys:", Object.keys(result));
console.log("Session type:", typeof result.session);
console.log("Session.prompt:", typeof result.session?.prompt);
console.log("Session.agent:", typeof result.session?.agent);

// Test a simple prompt
result.session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await result.session.prompt("Привет! Кто ты?");
console.log("\n\nDone!");
