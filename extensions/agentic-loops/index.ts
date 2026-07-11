import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeReviewLoop } from "./loops/code-review.ts";
import { registerGuidedWorkflow } from "./guided/workflow.ts";
import type { AgenticLoop } from "./runtime/types.ts";

const loops: AgenticLoop[] = [registerCodeReviewLoop];

export default function agenticLoopsExtension(pi: ExtensionAPI) {
  registerGuidedWorkflow(pi);
  for (const register of loops) {
    register(pi);
  }

  pi.registerCommand("agentic-loops", {
    description: "List available agentic loops",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Available workflows: guided, code-review", "info");
    },
  });
}
