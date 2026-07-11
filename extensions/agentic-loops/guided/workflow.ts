import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type GuidedPhase = "idle" | "planning" | "ready" | "executing" | "review";

interface GuidedStep {
  text: string;
  status: "pending" | "done";
}

interface GuidedState {
  phase: GuidedPhase;
  task: string;
  plan: GuidedStep[];
  currentStep: number;
  notes: string[];
  stepBaseline?: string;
  lastDiffFile?: string;
}

const ENTRY_TYPE = "agentic-guided-state";
const BLOCKED_TOOLS = new Set(["edit", "write", "apply_patch"]);

function emptyState(): GuidedState {
  return { phase: "idle", task: "", plan: [], currentStep: 0, notes: [] };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function captureBaseline(): string {
  return git(["stash", "create"]) || git(["rev-parse", "HEAD"]);
}

function writeStepDiff(state: GuidedState): string | undefined {
  if (!state.stepBaseline) return undefined;
  const tracked = execFileSync("git", ["diff", "--binary", "--no-ext-diff", state.stepBaseline, "--"], {
    cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024,
  });
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const untrackedNote = untracked ? `\n# New untracked files\n${untracked.split("\n").map((file) => `# ${file}`).join("\n")}\n` : "";
  const gitDirValue = git(["rev-parse", "--git-dir"]);
  const gitDir = isAbsolute(gitDirValue) ? gitDirValue : resolve(process.cwd(), gitDirValue);
  const directory = join(gitDir, "pi-guided");
  const file = join(directory, `step-${state.currentStep + 1}.diff`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${tracked}${untrackedNote}`, "utf8");
  return file;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function lastAssistantText(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message as AgentMessage;
    if (isAssistantMessage(message)) return assistantText(message);
  }
  return "";
}

function parsePlan(text: string): GuidedStep[] {
  const steps: GuidedStep[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:\d+[.)]|[-*]\s*\[[ xX]?\])\s+(.+?)\s*$/);
    if (match?.[1]) steps.push({ text: match[1], status: "pending" });
  }
  return steps;
}

function isReadOnlyBash(command: string): boolean {
  if (/[>|;&]|\b(rm|del|move|mv|copy|cp|mkdir|rmdir|git\s+(add|commit|checkout|restore|reset|clean|merge|rebase|push)|npm\s+(install|update)|pnpm\s+(install|add)|yarn\s+add)\b/i.test(command)) {
    return false;
  }
  return /^\s*(rg|grep|find|ls|dir|Get-ChildItem|Get-Content|Select-String|git\s+(status|diff|log|show)|cat|type|pwd|Get-Location)\b/i.test(command);
}

function phaseLabel(state: GuidedState): string {
  if (state.phase === "idle") return "off";
  if (state.phase === "planning") return "planning";
  if (state.phase === "ready") return "plan ready";
  if (state.phase === "executing") return `step ${state.currentStep + 1}/${state.plan.length}`;
  return `review ${state.currentStep + 1}/${state.plan.length}`;
}

export function registerGuidedWorkflow(pi: ExtensionAPI): void {
  let state = emptyState();

  const persist = () => pi.appendEntry(ENTRY_TYPE, state);
  const updateUi = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("agentic-guided", state.phase === "idle" ? undefined : `guided: ${phaseLabel(state)}`);
    if (state.phase === "idle" || state.plan.length === 0) {
      ctx.ui.setWidget("agentic-guided-plan", undefined);
      return;
    }
    ctx.ui.setWidget(
      "agentic-guided-plan",
      state.plan.map((step, index) => {
        const marker = step.status === "done" ? "[x]" : index === state.currentStep ? "[>]" : "[ ]";
        return `${marker} ${index + 1}. ${step.text}`;
      }),
    );
  };

  const startCurrentStep = (ctx: ExtensionContext) => {
    const step = state.plan[state.currentStep];
    if (!step) {
      ctx.ui.notify("No pending guided step.", "info");
      return;
    }
    state.phase = "executing";
    try {
      state.stepBaseline = captureBaseline();
    } catch {
      state.stepBaseline = undefined;
      ctx.ui.notify("Could not capture a Git baseline; the step will run without a diff artifact.", "warning");
    }
    persist();
    updateUi(ctx);
    pi.sendUserMessage(
      `Execute only guided step ${state.currentStep + 1}: ${step.text}\n\nStop after this step. Summarize changed files, validation performed, risks, and the proposed next step.`,
    );
  };

  pi.registerCommand("guided", {
    description: "Start an interactive, one-step-at-a-time implementation",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /guided <task>", "warning");
        return;
      }
      state = { phase: "planning", task, plan: [], currentStep: 0, notes: [] };
      persist();
      updateUi(ctx);
      pi.sendUserMessage(
        `GUIDED TASK: ${task}\n\nAnalyze the repository and requirements in read-only mode. Ask only blocking clarification questions. When enough is known, provide a short numbered plan of independently verifiable implementation steps. Do not modify files.`,
      );
    },
  });

  pi.registerCommand("approve-plan", {
    description: "Approve the last numbered plan and start its first step",
    handler: async (_args, ctx) => {
      if (state.phase !== "planning" && state.phase !== "ready") {
        ctx.ui.notify("No guided plan is awaiting approval.", "warning");
        return;
      }
      const plan = parsePlan(lastAssistantText(ctx));
      if (plan.length === 0) {
        ctx.ui.notify("Could not find a numbered plan in the last assistant response.", "error");
        return;
      }
      state.plan = plan;
      state.currentStep = 0;
      state.phase = "ready";
      persist();
      updateUi(ctx);
      startCurrentStep(ctx);
    },
  });

  pi.registerCommand("next", {
    description: "Accept the current guided step and execute the next one",
    handler: async (_args, ctx) => {
      if (state.phase !== "review") {
        ctx.ui.notify("The guided workflow is not waiting for step approval.", "warning");
        return;
      }
      state.plan[state.currentStep]!.status = "done";
      state.currentStep += 1;
      if (state.currentStep >= state.plan.length) {
        state.phase = "ready";
        persist();
        updateUi(ctx);
        ctx.ui.notify("All planned steps are complete. Use /finish for the final audit.", "info");
        return;
      }
      startCurrentStep(ctx);
    },
  });

  pi.registerCommand("adjust", {
    description: "Add guidance before continuing: /adjust <instruction>",
    handler: async (args, ctx) => {
      const note = args.trim();
      if (state.phase === "idle" || !note) {
        ctx.ui.notify("Usage during a guided task: /adjust <instruction>", "warning");
        return;
      }
      state.notes.push(note);
      persist();
      pi.sendUserMessage(`Guided workflow adjustment: ${note}\nRevise the remaining plan or current proposal. Do not edit files until /next.`);
    },
  });

  pi.registerCommand("guided-status", {
    description: "Show guided workflow status",
    handler: async (_args, ctx) => {
      const plan = state.plan.map((step, index) => `${step.status === "done" ? "[x]" : "[ ]"} ${index + 1}. ${step.text}`).join("\n");
      ctx.ui.notify(`Guided: ${phaseLabel(state)}\nTask: ${state.task || "-"}${plan ? `\n${plan}` : ""}`, "info");
    },
  });

  pi.registerCommand("guided-cancel", {
    description: "Exit guided mode without reverting files",
    handler: async (_args, ctx) => {
      state = emptyState();
      persist();
      updateUi(ctx);
      ctx.ui.notify("Guided mode disabled. Existing changes were kept.", "info");
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (state.phase === "idle") return;
    const current = state.plan[state.currentStep];
    const instruction = state.phase === "executing"
      ? `You are in guided execution. Implement exactly one step: ${current?.text ?? "the approved step"}. Do not begin another plan step. End with changed files, checks, risks, and next-step proposal.`
      : "You are in guided read-only mode. Analyze, clarify, plan, or discuss the completed step. Do not modify files until the user explicitly approves execution.";
    return { systemPrompt: `${event.systemPrompt}\n\n[GUIDED WORKFLOW]\n${instruction}` };
  });

  pi.on("tool_call", async (event) => {
    if (state.phase === "idle" || state.phase === "executing") return;
    if (BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: "Guided workflow is awaiting approval; file mutations are disabled." };
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (!isReadOnlyBash(command)) {
        return { block: true, reason: "Guided workflow allows only read-only shell commands while awaiting approval." };
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (state.phase === "executing") {
      try {
        state.lastDiffFile = writeStepDiff(state);
      } catch (error) {
        state.lastDiffFile = undefined;
        ctx.ui.notify(`Could not write the step diff: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      state.phase = "review";
      persist();
      updateUi(ctx);
      const diffHint = state.lastDiffFile ? ` Diff: ${state.lastDiffFile}` : "";
      ctx.ui.notify(`Step complete.${diffHint} Review it, then use /next or /adjust.`, "info");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const entry = ctx.sessionManager.getEntries()
      .filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === ENTRY_TYPE)
      .pop() as { data?: GuidedState } | undefined;
    if (entry?.data) state = entry.data;
    updateUi(ctx);
  });
}
