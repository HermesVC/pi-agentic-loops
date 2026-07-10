import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { runSubagent } from "../runtime/subagent.ts";

const DEFAULT_MAX_DIFF_CHARS = 120_000;
const DEFAULT_MAX_ITERATIONS = 3;

interface ReviewInput {
  files?: string[];
  task: string;
  base?: string;
  maxDiffChars?: number;
  maxIterations?: number;
  applyFixes?: boolean;
  fixSeverity?: FixSeverityPolicy;
}

type FindingSeverity = "critical" | "high" | "medium" | "low";
type FixSeverityPolicy = "all" | "medium_and_above" | "critical_only";

interface ReviewRound {
  iteration: number;
  findings: string;
  selectedFindings?: string;
  fixerResult?: string;
}

type LoopStatus = "clean" | "findings" | "policy_complete" | "max_iterations" | "no_progress";

interface ReviewLoopResult {
  status: LoopStatus;
  iterations: number;
  rounds: ReviewRound[];
  finalFindings?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function toRepoPaths(cwd: string, files: string[] = []): string[] {
  return files.map((file) => {
    const absolute = isAbsolute(file) ? file : resolve(cwd, file);
    const repoPath = relative(cwd, absolute).replaceAll("\\", "/");
    if (repoPath === ".." || repoPath.startsWith("../")) {
      throw new Error(`File is outside the repository: ${file}`);
    }
    return repoPath;
  });
}

export function collectGitDiff(cwd: string, input: ReviewInput): string {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const paths = toRepoPaths(root, input.files);
  const pathArgs = paths.length ? ["--", ...paths] : [];
  const base = input.base?.trim() || "HEAD";
  const sections: string[] = [];

  try {
    sections.push(git(root, ["diff", "--no-ext-diff", "--find-renames", "--unified=40", base, ...pathArgs]));
  } catch {
    sections.push(git(root, ["diff", "--no-ext-diff", "--find-renames", "--unified=40", ...pathArgs]));
    sections.push(git(root, ["diff", "--cached", "--no-ext-diff", "--find-renames", "--unified=40", ...pathArgs]));
  }

  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (paths.length) untrackedArgs.push("--", ...paths);
  const untracked = git(root, untrackedArgs).split(/\r?\n/).filter(Boolean);
  for (const file of untracked) {
    try {
      sections.push(git(root, ["diff", "--no-index", "--no-ext-diff", "--unified=40", "--", "/dev/null", file]));
    } catch (error: any) {
      if (error?.stdout) sections.push(String(error.stdout));
    }
  }

  const diff = sections.filter(Boolean).join("\n").trim();
  if (!diff) {
    throw new Error(paths.length ? "No Git changes found for the selected files" : "No Git changes found");
  }

  const limit = input.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  if (diff.length <= limit) return diff;
  return `${diff.slice(0, limit)}\n\n[DIFF TRUNCATED: ${diff.length - limit} characters omitted]`;
}

function buildReviewPrompt(input: ReviewInput, diff: string, iteration: number): string {
  return [
    `Task context: ${input.task}`,
    `Review iteration: ${iteration}`,
    "Review the Git diff below. Treat unchanged files only as optional context and use the read tool sparingly.",
    "Prioritize behavioral bugs, regressions, security issues, data loss, broken contracts, and missing tests.",
    "Report findings first, ordered by severity. Start every finding with exactly one severity marker: [CRITICAL], [HIGH], [MEDIUM], or [LOW].",
    "For each finding include file and changed-line location, impact, and a concrete fix. Separate findings with a blank line.",
    "Do not report style preferences or pre-existing issues outside the diff unless the changed code makes them relevant.",
    "If there are no actionable findings, answer exactly: NO_FINDINGS",
    "\n--- GIT DIFF ---\n",
    diff,
  ].join("\n");
}

function buildFixPrompt(input: ReviewInput, diff: string, findings: string, iteration: number): string {
  return [
    `Task context: ${input.task}`,
    `Fix iteration: ${iteration}`,
    "Fix every actionable review finding that is supported by the code.",
    "Keep changes narrowly scoped. Preserve unrelated user changes and never revert the working tree.",
    "Read surrounding code as needed. Run focused tests or validation when practical.",
    "When finished, summarize files changed, fixes applied, and validation performed.",
    "\n--- REVIEW FINDINGS ---\n",
    findings,
    "\n--- CURRENT GIT DIFF ---\n",
    diff,
  ].join("\n");
}

const REVIEWER_PROMPT = [
  "You are a senior code reviewer.",
  "Base every finding on evidence in the supplied Git diff.",
  "You may read nearby repository code to verify contracts, but never replace diff-focused review with a broad repository audit.",
  "Be concise, specific, and avoid false positives.",
  "Every actionable finding must begin with [CRITICAL], [HIGH], [MEDIUM], or [LOW].",
].join(" ");

const FIXER_PROMPT = [
  "You are a senior engineer fixing findings produced by a separate reviewer.",
  "Edit the working tree directly, keep the patch focused, and preserve unrelated changes.",
  "Do not merely explain a fix: implement it and validate it when possible.",
].join(" ");

function isCleanReview(result: string): boolean {
  return result.trim() === "NO_FINDINGS";
}

function selectFindings(findings: string, policy: FixSeverityPolicy): string {
  if (policy === "all") return findings;

  const minimumRank = policy === "critical_only" ? 4 : 2;
  const ranks: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const blocks = findings
    .split(/\n\s*\n(?=\[(?:CRITICAL|HIGH|MEDIUM|LOW)\])/i)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .filter((block) => {
      const match = block.match(/^\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
      if (!match) return false;
      return ranks[match[1].toLowerCase() as FindingSeverity] >= minimumRank;
    })
    .join("\n\n");
}

function fingerprint(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

function formatResult(result: ReviewLoopResult): string {
  const labels: Record<LoopStatus, string> = {
    clean: "CLEAN",
    findings: "FINDINGS",
    policy_complete: "POLICY_COMPLETE",
    max_iterations: "MAX_ITERATIONS",
    no_progress: "NO_PROGRESS",
  };
  const lines = [`Status: ${labels[result.status]}`, `Iterations: ${result.iterations}`];
  if (result.finalFindings) lines.push("", "Final findings:", result.finalFindings);
  if (result.rounds.length) {
    lines.push("", "Round history:");
    for (const round of result.rounds) {
      lines.push(`- Round ${round.iteration}: findings reviewed${round.fixerResult ? ", fixes attempted" : ""}`);
    }
  }
  return lines.join("\n");
}

async function runCodeReviewLoop(
  cwd: string,
  input: ReviewInput,
  signal: AbortSignal | undefined,
  onStage: (message: string) => void,
): Promise<ReviewLoopResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const applyFixes = input.applyFixes ?? true;
  const fixSeverity = input.fixSeverity ?? "all";
  const rounds: ReviewRound[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    signal?.throwIfAborted();
    const diffBefore = collectGitDiff(cwd, input);
    onStage(`Reviewing Git diff (${iteration}/${maxIterations})`);
    const findings = await runSubagent({
      cwd,
      prompt: buildReviewPrompt(input, diffBefore, iteration),
      systemPrompt: REVIEWER_PROMPT,
      signal,
      tools: ["read"],
    });

    if (isCleanReview(findings)) {
      return { status: "clean", iterations: iteration, rounds };
    }

    const round: ReviewRound = { iteration, findings };
    rounds.push(round);
    if (!applyFixes) {
      return { status: "findings", iterations: iteration, rounds, finalFindings: findings };
    }

    const selectedFindings = selectFindings(findings, fixSeverity);
    round.selectedFindings = selectedFindings;
    if (!selectedFindings) {
      return { status: "policy_complete", iterations: iteration, rounds, finalFindings: findings };
    }

    onStage(`Applying ${fixSeverity} fixes (${iteration}/${maxIterations})`);
    round.fixerResult = await runSubagent({
      cwd,
      prompt: buildFixPrompt(input, diffBefore, selectedFindings, iteration),
      systemPrompt: FIXER_PROMPT,
      signal,
      tools: ["read", "edit", "write", "bash"],
    });

    const diffAfter = collectGitDiff(cwd, input);
    if (fingerprint(diffAfter) === fingerprint(diffBefore)) {
      return { status: "no_progress", iterations: iteration, rounds, finalFindings: findings };
    }
  }

  onStage("Running final verification");
  const finalDiff = collectGitDiff(cwd, input);
  const finalFindings = await runSubagent({
    cwd,
    prompt: buildReviewPrompt(input, finalDiff, maxIterations + 1),
    systemPrompt: REVIEWER_PROMPT,
    signal,
    tools: ["read"],
  });
  if (isCleanReview(finalFindings)) {
    return { status: "clean", iterations: maxIterations, rounds };
  }
  return { status: "max_iterations", iterations: maxIterations, rounds, finalFindings };
}

export function registerCodeReviewLoop(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_review_loop",
    label: "Code Review Loop",
    description: "Runs a Git-diff review, fix, and verify loop with isolated reviewer and fixer agents.",
    parameters: Type.Object({
      task: Type.String({ description: "What changed and why" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Optional files to include; defaults to all changed files" })),
      base: Type.Optional(Type.String({ description: "Git base revision; defaults to HEAD" })),
      maxDiffChars: Type.Optional(Type.Number({ minimum: 10_000, maximum: 500_000 })),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: DEFAULT_MAX_ITERATIONS })),
      applyFixes: Type.Optional(Type.Boolean({ description: "Apply fixes and verify them; defaults to true" })),
      fixSeverity: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("medium_and_above"),
        Type.Literal("critical_only"),
      ], { description: "Which finding severities the fixer may change; defaults to all" })),
    }),
    async execute(_toolCallId, params: ReviewInput, signal, onUpdate) {
      try {
        const result = await runCodeReviewLoop(process.cwd(), params, signal, (message) => {
          onUpdate?.({ content: [{ type: "text", text: message }] });
        });
        return { content: [{ type: "text", text: formatResult(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Code review loop failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  });

  const sendReview = async (args: string, ctx: any) => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Agent is busy. Run the review when it is idle.", "warning");
      return;
    }
    const [filesPart, ...taskParts] = args.split("--");
    const files = filesPart.split(/[,\r\n\s]+/).map((file) => file.trim()).filter(Boolean);
    const task = taskParts.join("--").trim() || "Review and fix current changes";
    const payload = files.length ? { files, task, applyFixes: true } : { task, applyFixes: true };
    pi.sendUserMessage(`Call code_review_loop with ${JSON.stringify(payload)} and report the final loop status.`);
  };

  pi.registerCommand("code-review-loop", {
    description: "Review, fix, and verify Git diff: /code-review-loop [files] -- task",
    handler: sendReview,
  });

  pi.registerCommand("agentic-loop", {
    description: "Run a loop: /agentic-loop code-review [files] -- task",
    handler: async (args, ctx) => {
      const [name, ...rest] = args.trim().split(/\s+/);
      if (name !== "code-review") {
        ctx.ui.notify("Usage: /agentic-loop code-review [files] -- task", "warning");
        return;
      }
      await sendReview(rest.join(" "), ctx);
    },
  });
}
