import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeReviewLoop } from "./loops/code-review.ts";
import type { AgenticLoop } from "./runtime/types.ts";

const loops: AgenticLoop[] = [registerCodeReviewLoop];

export default function agenticLoopsExtension(pi: ExtensionAPI) {
  for (const register of loops) {
    register(pi);
  }

  pi.registerCommand("agentic-loops", {
    description: "List available agentic loops",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Available loops: code-review", "info");
    },
  });
}
