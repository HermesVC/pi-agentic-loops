import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { runSubagent } from "../runtime/subagent.ts";

const DEFAULT_MAX_DIFF_CHARS = 120_000;
const LIGHT_MAX_DIFF_CHARS = 40_000;
const LOCAL_REVIEW_CHUNK_CHARS = 12_000;
const REVIEW_TOOLS = ["read", "grep", "find", "ls"];
const LIGHT_REVIEW_TOOLS = ["read", "grep"];
const LIGHT_FIXER_TOOLS = ["read", "grep", "edit", "write"];

type FindingSeverity = "critical" | "high" | "medium" | "low";
type FixSeverityPolicy = "all" | "medium_and_above" | "critical_only";
type ReviewMode = "fast" | "strict" | "light";
type ExecutionProfile = "standard" | "local";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ReviewProfile {
  maxDiffChars: number;
  reviewTools: string[];
  fixerTools: string[];
  timeoutMinutes: number;
  maxModelCalls: (maxFixRounds: number, applyFixes: boolean) => number;
  defaultApplyFixes: boolean;
  defaultFixSeverity: FixSeverityPolicy;
  evidenceCheck: boolean;
  blindVerification: boolean;
  lightVerification: boolean;
  finalReview: boolean;
  structuredThinking: ThinkingLevel;
  compactPrompts: boolean;
}
type LoopStatus = "clean" | "findings" | "policy_complete" | "no_progress" | "budget_exhausted" | "change_limit" | "validation_failed";

interface ValidationResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
}

interface ValidationRun {
  phase: string;
  results: ValidationResult[];
}

interface RoundSnapshot {
  root: string;
  files: Map<string, Buffer | null>;
}

interface Finding {
  id: string;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  file: string;
  line?: number;
  evidence: string;
  impact: string;
  fix: string;
}

interface ReviewInput {
  profile?: ExecutionProfile;
  files?: string[];
  task?: string;
  reviewRules?: string;
  base?: string;
  maxDiffChars?: number;
  maxIterations?: number;
  applyFixes?: boolean;
  fixSeverity?: FixSeverityPolicy;
  mode?: ReviewMode;
  maxModelCalls?: number;
  timeoutMinutes?: number;
  maxChangedLines?: number;
  validationCommands?: string[];
  validationTimeoutMinutes?: number;
  verifierModel?: string;
}

interface VerificationResult {
  id: string;
  verdict: "resolved" | "unresolved" | "inconclusive";
  evidence: string;
}

interface VerificationRun {
  round: number;
  results: VerificationResult[];
}

interface LoopResult {
  status: LoopStatus;
  mode: ReviewMode;
  modelCalls: number;
  reviewChunks: number;
  fixRounds: number;
  findings: Finding[];
  unresolved: Finding[];
  durationMs: number;
  stages: Array<{ label: string; durationMs: number }>;
  validation: ValidationRun[];
  verification: VerificationRun[];
  rollbacks: number;
  summary?: string;
}

const execAsync = promisify(exec);

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function activityLabel(activity: string): string {
  const labels: Record<string, string> = {
    thinking: "thinking",
    read: "reading files",
    grep: "searching code",
    find: "finding files",
    ls: "listing files",
    edit: "editing code",
    write: "writing files",
    bash: "running command",
  };
  return labels[activity] ?? `using ${activity}`;
}

async function runValidation(
  cwd: string,
  commands: string[],
  phase: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  stage: (text: string) => void,
): Promise<ValidationRun> {
  const results: ValidationResult[] = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    signal?.throwIfAborted();
    stage(`Validation ${phase} | command ${index + 1}/${commands.length} | ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        signal,
      });
      results.push({ command, passed: true, exitCode: 0, output: `${stdout}${stderr}`.trim().slice(-4_000) });
    } catch (error: any) {
      signal?.throwIfAborted();
      results.push({
        command,
        passed: false,
        exitCode: typeof error?.code === "number" ? error.code : null,
        output: `${error?.stdout ?? ""}${error?.stderr ?? error?.message ?? ""}`.trim().slice(-4_000),
      });
    }
  }
  return { phase, results };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

function toRepoPaths(root: string, cwd: string, files: string[] = []): string[] {
  return files.map((file) => {
    const absolute = isAbsolute(file) ? file : resolve(cwd, file);
    const repoPath = relative(root, absolute).replaceAll("\\", "/");
    if (repoPath === ".." || repoPath.startsWith("../")) throw new Error(`File is outside the repository: ${file}`);
    return repoPath;
  });
}

function collectUntrackedPatches(root: string, paths: string[], contextLines: number): string[] {
  const args = ["ls-files", "--others", "--exclude-standard"];
  if (paths.length) args.push("--", ...paths);
  const files = git(root, args).split(/\r?\n/).filter(Boolean);
  return files.flatMap((file) => {
    try {
      return [git(root, ["diff", "--no-index", "--no-ext-diff", `--unified=${contextLines}`, "--", "/dev/null", file])];
    } catch (error: any) {
      return error?.stdout ? [String(error.stdout)] : [];
    }
  });
}

export function collectGitDiff(cwd: string, input: ReviewInput, truncate = true): string {
  const root = repoRoot(cwd);
  const paths = toRepoPaths(root, cwd, input.files);
  const pathArgs = paths.length ? ["--", ...paths] : [];
  const contextLines = input.profile === "local" || input.mode === "light" ? 15 : 40;
  const sections: string[] = [];
  try {
    sections.push(git(root, ["diff", "--no-ext-diff", "--find-renames", `--unified=${contextLines}`, input.base?.trim() || "HEAD", ...pathArgs]));
  } catch {
    sections.push(git(root, ["diff", "--no-ext-diff", "--find-renames", `--unified=${contextLines}`, ...pathArgs]));
    sections.push(git(root, ["diff", "--cached", "--no-ext-diff", "--find-renames", `--unified=${contextLines}`, ...pathArgs]));
  }
  sections.push(...collectUntrackedPatches(root, paths, contextLines));
  const diff = sections.filter(Boolean).join("\n").trim();
  if (!diff) throw new Error(paths.length ? "No Git changes found for the selected files" : "No Git changes found");
  if (!truncate) return diff;
  const limit = input.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  return diff.length <= limit ? diff : `${diff.slice(0, limit)}\n\n[DIFF TRUNCATED: ${diff.length - limit} characters omitted]`;
}

function changedFiles(cwd: string, input: ReviewInput): string[] {
  const root = repoRoot(cwd);
  const selected = toRepoPaths(root, cwd, input.files);
  const args = ["diff", "--name-only", input.base?.trim() || "HEAD"];
  if (selected.length) args.push("--", ...selected);
  let files: string[] = [];
  try { files = git(root, args).split(/\r?\n/).filter(Boolean); } catch { files = []; }
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (selected.length) untrackedArgs.push("--", ...selected);
  return [...new Set([...files, ...git(root, untrackedArgs).split(/\r?\n/).filter(Boolean)])];
}

function changedLineCount(cwd: string, input: ReviewInput): number {
  const root = repoRoot(cwd);
  const selected = toRepoPaths(root, cwd, input.files);
  const args = ["diff", "--numstat", input.base?.trim() || "HEAD"];
  if (selected.length) args.push("--", ...selected);
  const output = git(root, args);
  return output.split(/\r?\n/).reduce((total, line) => {
    const [added, removed] = line.split("\t");
    return total + (Number(added) || 0) + (Number(removed) || 0);
  }, 0);
}

function captureRoundSnapshot(cwd: string, files: string[]): RoundSnapshot {
  const root = repoRoot(cwd);
  const snapshots = new Map<string, Buffer | null>();
  for (const file of files) {
    const absolute = resolve(root, file);
    snapshots.set(file, existsSync(absolute) ? readFileSync(absolute) : null);
  }
  return { root, files: snapshots };
}

function restoreRoundSnapshot(snapshot: RoundSnapshot, currentChangedFiles: string[]): void {
  const paths = new Set([...snapshot.files.keys(), ...currentChangedFiles]);
  for (const file of paths) {
    const absolute = resolve(snapshot.root, file);
    if (snapshot.files.has(file)) {
      const saved = snapshot.files.get(file);
      if (saved === null) {
        rmSync(absolute, { force: true });
        continue;
      }
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, saved);
      continue;
    }
    try {
      const original = execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: snapshot.root,
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, original);
    } catch {
      rmSync(absolute, { force: true });
    }
  }
}

function changedOutsideAllowed(snapshot: RoundSnapshot, currentFiles: string[], allowedFiles: string[]): string[] {
  const allowed = new Set(allowedFiles);
  return currentFiles.filter((file) => {
    if (allowed.has(file)) return false;
    const hasSaved = snapshot.files.has(file);
    const saved = snapshot.files.get(file);
    const absolute = resolve(snapshot.root, file);
    if (!hasSaved) return true;
    if (saved === null) return existsSync(absolute);
    return !existsSync(absolute) || !saved.equals(readFileSync(absolute));
  });
}

export function jsonFromResponse(text: string): any {
  const fenced = text.match(/```(?:[a-z][\w+-]*)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  const preview = source.replace(/\s+/g, " ").trim().slice(0, 300) || "[empty response]";
  if (start < 0 || end < start) throw new Error(`Agent returned no JSON object. Response preview: ${preview}`);
  const candidate = source.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent returned invalid JSON object: ${detail}. Response preview: ${preview}`);
  }
}

function splitLargeDiffSection(section: string, targetChars: number): string[] {
  if (section.length <= targetChars) return [section];
  const hunkStarts = [...section.matchAll(/^@@/gm)].map((match) => match.index ?? 0);
  if (!hunkStarts.length) return [section];
  const header = section.slice(0, hunkStarts[0]);
  const hunks = hunkStarts.map((start, index) => section.slice(start, hunkStarts[index + 1] ?? section.length));
  const chunks: string[] = [];
  let current = header;
  for (const hunk of hunks) {
    if (current.length > header.length && current.length + hunk.length > targetChars) {
      chunks.push(current.trimEnd());
      current = header;
    }
    current += hunk;
  }
  if (current.length > header.length) chunks.push(current.trimEnd());
  return chunks;
}

export function splitGitDiffForReview(diff: string, targetChars = LOCAL_REVIEW_CHUNK_CHARS): string[] {
  const fileSections = diff.split(/(?=^diff --git )/m).filter((section) => section.trim());
  const sections = fileSections.flatMap((section) => splitLargeDiffSection(section, targetChars));
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    if (current && current.length + section.length + 1 > targetChars) {
      chunks.push(current.trimEnd());
      current = "";
    }
    if (!current && section.length > targetChars) {
      chunks.push(section.trimEnd());
      continue;
    }
    current += `${current ? "\n" : ""}${section}`;
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.length ? chunks : [diff];
}

export function selectDiffFiles(diff: string, files: string[]): string {
  const wanted = new Set(files.map((file) => file.replaceAll("\\", "/").replace(/^\.?\//, "").toLowerCase()));
  if (!wanted.size) return diff;
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.trim());
  const selected = sections.filter((section) => {
    const match = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!match) return false;
    const before = match[1].replace(/^"|"$/g, "").toLowerCase();
    const after = match[2].replace(/^"|"$/g, "").toLowerCase();
    return wanted.has(before) || wanted.has(after);
  });
  return selected.length ? selected.join("\n").trim() : diff;
}

function normalizeFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  const severities = new Set(["critical", "high", "medium", "low"]);
  return value.flatMap((raw: any, index) => {
    const severity = String(raw?.severity ?? "").toLowerCase();
    if (!severities.has(severity) || !raw?.file || !raw?.evidence || !raw?.fix) return [];
    return [{
      id: String(raw.id || `F-${String(index + 1).padStart(3, "0")}`),
      severity: severity as FindingSeverity,
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
      title: String(raw.title || "Untitled finding"),
      file: String(raw.file),
      line: Number.isFinite(Number(raw.line)) ? Number(raw.line) : undefined,
      evidence: String(raw.evidence),
      impact: String(raw.impact || ""),
      fix: String(raw.fix),
    }];
  });
}

function mergeChunkFindings(findings: Finding[]): Finding[] {
  const severityRank: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const merged = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.file.toLowerCase()}:${finding.line ?? ""}:${finding.title.toLowerCase().trim()}`;
    const previous = merged.get(key);
    if (!previous || severityRank[finding.severity] > severityRank[previous.severity] || finding.confidence > previous.confidence) {
      merged.set(key, finding);
    }
  }
  return [...merged.values()].map((finding, index) => ({
    ...finding,
    id: `F-${String(index + 1).padStart(3, "0")}`,
  }));
}

function selectFindings(findings: Finding[], policy: FixSeverityPolicy): Finding[] {
  const ranks: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const minimum = policy === "critical_only" ? 4 : policy === "medium_and_above" ? 2 : 1;
  return findings.filter((finding) => ranks[finding.severity] >= minimum);
}

function resolveProfile(mode: ReviewMode, input: ReviewInput): ReviewProfile {
  const maxFixRounds = input.maxIterations ?? 1;
  const applyFixes = input.applyFixes ?? true;
  switch (mode) {
    case "light":
      return {
        maxDiffChars: LIGHT_MAX_DIFF_CHARS,
        reviewTools: LIGHT_REVIEW_TOOLS,
        fixerTools: LIGHT_FIXER_TOOLS,
        timeoutMinutes: 5,
        maxModelCalls: (rounds, fixes) => 1 + (fixes ? rounds * 2 : 0) + 1,
        defaultApplyFixes: true,
        defaultFixSeverity: "medium_and_above",
        evidenceCheck: false,
        blindVerification: false,
        lightVerification: fixes,
        finalReview: false,
        structuredThinking: "off",
        compactPrompts: true,
      };
    case "strict":
      return {
        maxDiffChars: DEFAULT_MAX_DIFF_CHARS,
        reviewTools: REVIEW_TOOLS,
        fixerTools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
        timeoutMinutes: 10,
        maxModelCalls: (_rounds, _fixes) => 2 + (2 * maxFixRounds) + 2,
        defaultApplyFixes: true,
        defaultFixSeverity: "all",
        evidenceCheck: true,
        blindVerification: true,
        lightVerification: false,
        finalReview: true,
        structuredThinking: "minimal",
        compactPrompts: false,
      };
    case "fast":
    default:
      return {
        maxDiffChars: DEFAULT_MAX_DIFF_CHARS,
        reviewTools: REVIEW_TOOLS,
        fixerTools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
        timeoutMinutes: 10,
        maxModelCalls: (_rounds, _fixes) => 2 + (2 * maxFixRounds),
        defaultApplyFixes: true,
        defaultFixSeverity: "all",
        evidenceCheck: false,
        blindVerification: true,
        lightVerification: false,
        finalReview: false,
        structuredThinking: "minimal",
        compactPrompts: false,
      };
  }
}

function applyProfileDefaults(input: ReviewInput): { mode: ReviewMode; profile: ReviewProfile; effective: ReviewInput } {
  const mode = input.profile === "local" ? "light" : (input.mode ?? "fast");
  const profile = resolveProfile(mode, input);
  const effective: ReviewInput = {
    ...input,
    mode,
    maxDiffChars: input.maxDiffChars ?? profile.maxDiffChars,
    timeoutMinutes: input.timeoutMinutes ?? profile.timeoutMinutes,
    fixSeverity: input.fixSeverity ?? profile.defaultFixSeverity,
    applyFixes: input.applyFixes ?? profile.defaultApplyFixes,
  };
  effective.maxModelCalls = input.maxModelCalls
    ?? profile.maxModelCalls(input.maxIterations ?? 1, effective.applyFixes ?? profile.defaultApplyFixes);
  return { mode, profile, effective };
}

function reviewPrompt(input: ReviewInput, diff: string, purpose = "initial review", compact = false): string {
  if (compact) {
    return [
      `Purpose: ${purpose}`,
      input.task?.trim() ? `Task: ${input.task.trim()}` : "",
      input.reviewRules?.trim() ? `Rules:\n${input.reviewRules.trim()}` : "",
      "Review the Git diff. Use read/grep only when needed to confirm a concrete bug. No style nitpicks or speculation.",
      "Return JSON only: {\"findings\":[{\"id\":\"F-001\",\"severity\":\"critical|high|medium|low\",\"confidence\":0.0,\"title\":\"\",\"file\":\"path\",\"line\":1,\"evidence\":\"\",\"impact\":\"\",\"fix\":\"\"}]}",
      "Use {\"findings\":[]} if clean.",
      "\n--- GIT DIFF ---\n",
      diff,
    ].filter(Boolean).join("\n");
  }
  return [
    `Purpose: ${purpose}`,
    `Task context: ${input.task?.trim() || "Review current changes"}`,
    input.reviewRules?.trim() ? `User review rules:\n${input.reviewRules.trim()}` : "",
    "Review only the supplied Git diff. Use repository search tools to verify types, callers, cache behavior, persistence round-trips, and other contracts before reporting a finding.",
    "Do not report style preferences. Omit speculative findings. Confidence must be 0..1.",
    "Return JSON only: {\"findings\":[{\"id\":\"F-001\",\"severity\":\"critical|high|medium|low\",\"confidence\":0.0,\"title\":\"...\",\"file\":\"...\",\"line\":1,\"evidence\":\"verified evidence\",\"impact\":\"...\",\"fix\":\"...\"}]}",
    "Use {\"findings\":[]} when clean.",
    "\n--- GIT DIFF ---\n",
    diff,
  ].filter(Boolean).join("\n");
}

function fixerPrompt(input: ReviewInput, diff: string, findings: Finding[], allowedFiles: string[], compact = false): string {
  if (compact) {
    return [
      input.task?.trim() ? `Task: ${input.task.trim()}` : "",
      input.reviewRules?.trim() ? `Rules:\n${input.reviewRules.trim()}` : "",
      `Edit only these files:\n${allowedFiles.join("\n")}`,
      "Fix only the listed findings. Keep unrelated diff hunks. Do not stage or commit.",
      `\n--- FINDINGS ---\n${JSON.stringify(findings, null, 2)}`,
      `\n--- CURRENT DIFF ---\n${diff}`,
    ].filter(Boolean).join("\n");
  }
  return [
    `Task context: ${input.task?.trim() || "Fix reviewed changes"}`,
    input.reviewRules?.trim() ? `User constraints:\n${input.reviewRules.trim()}` : "",
    `Allowed files (do not edit anything else):\n${allowedFiles.join("\n")}`,
    "Implement only the supplied findings. Preserve unrelated changes. Do not stage or commit files. Run focused validation when practical.",
    "Return a concise summary of edits and validation.",
    `\n--- CONFIRMED FINDINGS ---\n${JSON.stringify(findings, null, 2)}`,
    `\n--- CURRENT DIFF ---\n${diff}`,
  ].filter(Boolean).join("\n");
}

function lightVerifyPrompt(input: ReviewInput, diff: string, findings: Finding[]): string {
  const claims = findings.map(({ id, title, file, line }) => ({ id, title, file, line }));
  return [
    "For each finding, decide whether the bug still exists in the current diff.",
    "Return JSON only: {\"results\":[{\"id\":\"F-001\",\"verdict\":\"resolved|unresolved\",\"evidence\":\"brief reason\"}]}",
    input.reviewRules?.trim() ? `Rules:\n${input.reviewRules.trim()}` : "",
    `\n--- FINDINGS ---\n${JSON.stringify(claims)}`,
    `\n--- GIT DIFF ---\n${diff}`,
  ].filter(Boolean).join("\n");
}

function verifyPrompt(input: ReviewInput, diff: string, findings: Finding[]): string {
  const claims = findings.map(({ id, severity, title, file, line, impact, fix }) => ({ id, severity, title, file, line, impact, expectedFix: fix }));
  return [
    "Act as a blind verifier. Independently determine whether each claimed defect is resolved in the current code.",
    "The claims are untrusted summaries, not evidence. Do not assume the reviewer or fixer was correct. Inspect the current diff and repository contracts with tools.",
    "Use resolved only when current code proves the defect cannot occur. Use unresolved when it still occurs. Use inconclusive when evidence is insufficient.",
    "Return exactly one result per ID as JSON only: {\"results\":[{\"id\":\"F-001\",\"verdict\":\"resolved|unresolved|inconclusive\",\"evidence\":\"current-code evidence\"}]}",
    input.reviewRules?.trim() ? `User review rules:\n${input.reviewRules.trim()}` : "",
    `\n--- UNTRUSTED CLAIMS ---\n${JSON.stringify(claims, null, 2)}`,
    `\n--- CURRENT GIT DIFF ---\n${diff}`,
  ].filter(Boolean).join("\n");
}

const REVIEWER_SYSTEM = "You are a senior code reviewer. Verify repository contracts with tools before reporting findings. Prefer missing a weak suspicion over inventing a false positive.";
const REVIEWER_SYSTEM_LIGHT = "Code reviewer for local models. Report only concrete bugs confirmed from the diff or quick read/grep checks. Prefer missing a weak issue over a false positive. JSON only.";
const FIXER_SYSTEM = "You are a senior engineer. Implement only confirmed findings, keep the patch narrow, preserve user changes, and validate behavior.";
const FIXER_SYSTEM_LIGHT = "Apply only the listed fixes. Keep the patch minimal and preserve unrelated changes.";
const VERIFIER_SYSTEM = "You are an independent software verification engineer. Judge only current-code evidence. Never trust another agent's conclusion, never infer success from an attempted edit, and mark insufficient evidence inconclusive.";
const LIGHT_VERIFIER_SYSTEM = "Check whether each listed finding still applies to the current diff. JSON only.";

async function runLoop(cwd: string, input: ReviewInput, signal: AbortSignal | undefined, stage: (text: string) => void): Promise<LoopResult> {
  const loopStartedAt = Date.now();
  const stages: Array<{ label: string; durationMs: number }> = [];
  const { mode, profile, effective } = applyProfileDefaults(input);
  const maxFixRounds = effective.maxIterations ?? 1;
  const initialDiff = collectGitDiff(cwd, effective);
  const reviewChunks = mode === "light" ? splitGitDiffForReview(initialDiff) : [initialDiff];
  const maxCalls = input.maxModelCalls
    ?? profile.maxModelCalls(maxFixRounds, effective.applyFixes ?? profile.defaultApplyFixes) + reviewChunks.length - 1;
  const timeoutMs = (effective.timeoutMinutes ?? profile.timeoutMinutes) * 60_000;
  const maxLines = effective.maxChangedLines ?? (mode === "light" ? 500 : 2_000);
  const validationCommands = effective.validationCommands?.map((command) => command.trim()).filter(Boolean) ?? [];
  const validationTimeoutMs = (effective.validationTimeoutMinutes ?? 5) * 60_000;
  const policy = effective.fixSeverity ?? profile.defaultFixSeverity;
  const allowedFiles = changedFiles(cwd, effective);
  const reviewerSystem = profile.compactPrompts ? REVIEWER_SYSTEM_LIGHT : REVIEWER_SYSTEM;
  const fixerSystem = profile.compactPrompts ? FIXER_SYSTEM_LIGHT : FIXER_SYSTEM;
  let modelCalls = 0;
  let fixRounds = 0;
  let rollbacks = 0;
  let structuredRecoveryUsed = false;
  const validation: ValidationRun[] = [];
  const verificationRuns: VerificationRun[] = [];
  const finish = (result: Omit<LoopResult, "durationMs" | "stages" | "validation" | "verification" | "rollbacks" | "reviewChunks">): LoopResult => ({
    ...result,
    durationMs: Date.now() - loopStartedAt,
    stages,
    validation,
    verification: verificationRuns,
    rollbacks,
    reviewChunks: reviewChunks.length,
  });
  const call = async (
    label: string,
    prompt: string,
    systemPrompt: string,
    tools: string[],
    model?: string,
    thinkingLevel?: ThinkingLevel,
  ) => {
    if (modelCalls >= maxCalls) throw new Error("MODEL_CALL_BUDGET_EXHAUSTED");
    modelCalls++;
    const callNumber = modelCalls;
    const callStartedAt = Date.now();
    stage(`${label} | call ${callNumber}/${maxCalls} | starting`);
    try {
      return await runSubagent({
        cwd, prompt, systemPrompt, tools, signal, timeoutMs, model, thinkingLevel,
        onProgress: ({ activity, elapsedMs }) => {
          stage(`${label} | call ${callNumber}/${maxCalls} | ${activityLabel(activity)} | ${formatDuration(elapsedMs)}`);
        },
      });
    } finally {
      stages.push({ label, durationMs: Date.now() - callStartedAt });
    }
  };
  const structuredCall = async (label: string, prompt: string, systemPrompt: string, tools: string[], model?: string): Promise<any> => {
    let response = "";
    try {
      response = await call(label, prompt, systemPrompt, tools, model, profile.structuredThinking);
      return jsonFromResponse(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoverable = message.startsWith("Agent returned no JSON object")
        || message.startsWith("Agent returned invalid JSON object")
        || message.startsWith("Subagent returned no final text");
      if (!recoverable) throw error;
      if (structuredRecoveryUsed) throw error;
      structuredRecoveryUsed = true;
      stage(`${label} | invalid structured response | retrying once`);
      const recoveryPrompt = [
        prompt,
        "\n--- RESPONSE FORMAT RECOVERY ---",
        "Your previous attempt did not contain one valid JSON object. Repeat the task from the supplied evidence and return only the exact requested JSON object. Do not explain, apologize, or use prose outside JSON.",
        `Previous failure:\n${response.slice(0, 4_000) || message}`,
      ].join("\n");
      return jsonFromResponse(await call(`${label} JSON recovery`, recoveryPrompt, systemPrompt, tools, model, "off"));
    }
  };

  const chunkFindings: Finding[] = [];
  for (let index = 0; index < reviewChunks.length; index++) {
    const label = reviewChunks.length > 1 ? `Reviewing chunk ${index + 1}/${reviewChunks.length}` : "Reviewing";
    const response = await structuredCall(
      label,
      reviewPrompt(effective, reviewChunks[index], `initial review chunk ${index + 1}/${reviewChunks.length}`, profile.compactPrompts),
      reviewerSystem,
      profile.reviewTools,
    );
    chunkFindings.push(...normalizeFindings(response.findings));
  }
  let findings = mergeChunkFindings(chunkFindings);
  if (!findings.length) return finish({ status: "clean", mode, modelCalls, fixRounds, findings: [], unresolved: [] });

  if (profile.evidenceCheck) {
    const evidencePrompt = reviewPrompt(
      effective,
      initialDiff,
      `evidence check for these candidate findings:\n${JSON.stringify(findings, null, 2)}`,
      profile.compactPrompts,
    );
    findings = normalizeFindings((await structuredCall("Checking evidence", evidencePrompt, reviewerSystem, profile.reviewTools)).findings);
    if (!findings.length) return finish({ status: "clean", mode, modelCalls, fixRounds, findings: [], unresolved: [] });
  }

  const selected = selectFindings(findings, policy);
  if (!(effective.applyFixes ?? profile.defaultApplyFixes)) return finish({ status: "findings", mode, modelCalls, fixRounds, findings, unresolved: findings });
  if (!selected.length) return finish({ status: "policy_complete", mode, modelCalls, fixRounds, findings, unresolved: findings });

  const baseline = validationCommands.length
    ? await runValidation(cwd, validationCommands, "baseline", validationTimeoutMs, signal, stage)
    : undefined;
  if (baseline) validation.push(baseline);

  let unresolved = selected;
  let previousFingerprint = createHash("sha256").update(collectGitDiff(cwd, effective, false)).digest("hex");
  for (let round = 1; round <= maxFixRounds && unresolved.length; round++) {
    fixRounds = round;
    const fullBefore = collectGitDiff(cwd, effective);
    const before = mode === "light" ? selectDiffFiles(fullBefore, unresolved.map((finding) => finding.file)) : fullBefore;
    const snapshot = captureRoundSnapshot(cwd, changedFiles(cwd, {}));
    const rollback = () => {
      restoreRoundSnapshot(snapshot, changedFiles(cwd, {}));
      rollbacks++;
      stage(`Fixing round ${round} | rolled back to pre-round state`);
    };
    try {
      await call(
        `Fixing round ${round}`,
        fixerPrompt(effective, before, unresolved, allowedFiles, profile.compactPrompts),
        fixerSystem,
        profile.fixerTools,
      );
    } catch (error) {
      rollback();
      throw error;
    }

    const currentFiles = changedFiles(cwd, {});
    const outside = changedOutsideAllowed(snapshot, currentFiles, allowedFiles);
    if (outside.length) {
      rollback();
      return finish({ status: "change_limit", mode, modelCalls, fixRounds, findings, unresolved, summary: `Rolled back fixer changes outside the initial diff: ${outside.join(", ")}` });
    }
    if (changedLineCount(cwd, effective) > maxLines) {
      rollback();
      return finish({ status: "change_limit", mode, modelCalls, fixRounds, findings, unresolved, summary: `Rolled back fixer diff exceeding ${maxLines} changed lines` });
    }

    const fullDiff = collectGitDiff(cwd, effective, false);
    const currentFingerprint = createHash("sha256").update(fullDiff).digest("hex");
    if (currentFingerprint === previousFingerprint) return finish({ status: "no_progress", mode, modelCalls, fixRounds, findings, unresolved });
    previousFingerprint = currentFingerprint;

    if (baseline) {
      const afterFix = await runValidation(cwd, validationCommands, `after fix round ${round}`, validationTimeoutMs, signal, stage);
      validation.push(afterFix);
      const regressions = afterFix.results.filter((result, index) => !result.passed && baseline.results[index]?.passed);
      if (regressions.length) {
        rollback();
        return finish({
          status: "validation_failed",
          mode, modelCalls, fixRounds, findings, unresolved,
          summary: `Rolled back new validation regressions: ${regressions.map((result) => result.command).join(", ")}`,
        });
      }
    }

    if (profile.lightVerification) {
      const verificationDiff = selectDiffFiles(collectGitDiff(cwd, effective), unresolved.map((finding) => finding.file));
      const verificationResponse = await structuredCall(
        "Post-fix check",
        lightVerifyPrompt(effective, verificationDiff, unresolved),
        LIGHT_VERIFIER_SYSTEM,
        profile.reviewTools,
      );
      const verdicts = new Set(["resolved", "unresolved"]);
      const parsedResults: VerificationResult[] = Array.isArray(verificationResponse.results)
        ? verificationResponse.results.filter((result: any) => result?.id && verdicts.has(result?.verdict) && result?.evidence)
        : [];
      const results = unresolved.map((finding) => parsedResults.find((result) => result.id === finding.id) ?? {
        id: finding.id,
        verdict: "unresolved" as const,
        evidence: "Post-fix check omitted or malformed this finding result.",
      });
      verificationRuns.push({ round, results });
      unresolved = unresolved.filter((finding) => !results.some((result) => result.id === finding.id && result.verdict === "resolved"));
    } else if (profile.blindVerification) {
      const verificationResponse = await structuredCall(
        "Independent verification",
        verifyPrompt(effective, collectGitDiff(cwd, effective), unresolved),
        VERIFIER_SYSTEM,
        ["read", "grep"],
        effective.verifierModel,
      );
      const verdicts = new Set(["resolved", "unresolved", "inconclusive"]);
      const parsedResults: VerificationResult[] = Array.isArray(verificationResponse.results)
        ? verificationResponse.results.filter((result: any) => result?.id && verdicts.has(result?.verdict) && result?.evidence)
        : [];
      const results = unresolved.map((finding) => parsedResults.find((result) => result.id === finding.id) ?? {
        id: finding.id,
        verdict: "inconclusive" as const,
        evidence: "Verifier omitted or malformed this finding result.",
      });
      verificationRuns.push({ round, results });
      unresolved = unresolved.filter((finding) => !results.some((result) => result.id === finding.id && result.verdict === "resolved"));
    }
  }

  if (profile.finalReview && !unresolved.length) {
    const finalFindings = normalizeFindings((
      await structuredCall(
        "Final review",
        reviewPrompt(effective, collectGitDiff(cwd, effective), "final regression review", profile.compactPrompts),
        reviewerSystem,
        profile.reviewTools,
      )
    ).findings);
    if (finalFindings.length) return finish({ status: "findings", mode, modelCalls, fixRounds, findings, unresolved: finalFindings });
  }

  return finish({ status: unresolved.length ? "findings" : "clean", mode, modelCalls, fixRounds, findings, unresolved });
}

function formatResult(result: LoopResult): string {
  const lines = [
    `Status: ${result.status.toUpperCase()}`,
    `Mode: ${result.mode}`,
    `Model calls: ${result.modelCalls}`,
    `Review chunks: ${result.reviewChunks}`,
    `Fix rounds: ${result.fixRounds}`,
    `Rolled back rounds: ${result.rollbacks}`,
    `Total duration: ${formatDuration(result.durationMs)}`,
    `Initial findings: ${result.findings.length}`,
    `Unresolved findings: ${result.unresolved.length}`,
  ];
  if (result.stages.length) lines.push(`Stages: ${result.stages.map((item) => `${item.label} ${formatDuration(item.durationMs)}`).join("; ")}`);
  for (const run of result.validation) {
    const passed = run.results.filter((item) => item.passed).length;
    lines.push(`Validation ${run.phase}: ${passed}/${run.results.length} passed`);
    for (const item of run.results.filter((entry) => !entry.passed)) {
      lines.push(`  FAIL: ${item.command}${item.output ? `\n${item.output}` : ""}`);
    }
  }
  for (const run of result.verification) {
    lines.push(`Verification round ${run.round}: ${run.results.map((item) => `${item.id}=${item.verdict}`).join(", ")}`);
  }
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  if (result.unresolved.length) lines.push("", JSON.stringify({ findings: result.unresolved }, null, 2));
  return lines.join("\n");
}

function parseCommand(args: string): ReviewInput {
  const separator = args.match(/(?:^|\s)--(?:\s|$)/);
  const index = separator?.index ?? -1;
  const flagsPart = index >= 0 ? args.slice(0, index).trim() : args.trim();
  const rules = index >= 0 ? args.slice(index + separator![0].length).trim() : "";
  const tokens = flagsPart.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, "")) ?? [];
  const input: ReviewInput = {};
  const files: string[] = [];
  const validationCommands: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const value = tokens[i + 1];
    if (token === "--severity" && value) { input.fixSeverity = value as FixSeverityPolicy; i++; }
    else if (token === "--profile" && value) { input.profile = value as ExecutionProfile; i++; }
    else if (token === "--mode" && value) { input.mode = value as ReviewMode; i++; }
    else if (token === "--iterations" && value) { input.maxIterations = Number(value); i++; }
    else if (token === "--max-calls" && value) { input.maxModelCalls = Number(value); i++; }
    else if (token === "--timeout" && value) { input.timeoutMinutes = Number(value); i++; }
    else if (token === "--max-lines" && value) { input.maxChangedLines = Number(value); i++; }
    else if (token === "--base" && value) { input.base = value; i++; }
    else if (token === "--validate" && value) { validationCommands.push(value); i++; }
    else if (token === "--validation-timeout" && value) { input.validationTimeoutMinutes = Number(value); i++; }
    else if (token === "--verifier-model" && value) { input.verifierModel = value; i++; }
    else if (token === "--review-only") input.applyFixes = false;
    else if (token === "--apply-fixes") input.applyFixes = true;
    else if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    else files.push(...token.split(",").filter(Boolean));
  }
  if (files.length) input.files = files;
  if (validationCommands.length) input.validationCommands = validationCommands;
  if (rules) input.reviewRules = rules;
  return input;
}

export function registerCodeReviewLoop(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_review_loop",
    label: "Code Review Loop",
    description: "Runs structured Git-diff review, constrained fixes, and targeted verification.",
    parameters: Type.Object({
      task: Type.Optional(Type.String()),
      profile: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("local")])),
      reviewRules: Type.Optional(Type.String()),
      files: Type.Optional(Type.Array(Type.String())),
      base: Type.Optional(Type.String()),
      maxDiffChars: Type.Optional(Type.Number({ minimum: 10_000, maximum: 500_000 })),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, default: 1 })),
      applyFixes: Type.Optional(Type.Boolean()),
      fixSeverity: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("medium_and_above"), Type.Literal("critical_only")])),
      mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("strict"), Type.Literal("light")])),
      maxModelCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      timeoutMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
      maxChangedLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 })),
      validationCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
      validationTimeoutMinutes: Type.Optional(Type.Number({ minimum: 0.1, maximum: 30 })),
      verifierModel: Type.Optional(Type.String({ pattern: "^[^/]+/.+$" })),
    }),
    async execute(_id, params: ReviewInput, signal, onUpdate) {
      try {
        const result = await runLoop(process.cwd(), params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }] }));
        return { content: [{ type: "text", text: formatResult(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message === "MODEL_CALL_BUDGET_EXHAUSTED" ? "Model-call budget exhausted" : message;
        return { content: [{ type: "text", text: `Code review loop failed: ${status}` }], isError: true };
      }
    },
  });

  const sendReview = async (args: string, ctx: any) => {
    if (!ctx.isIdle()) return ctx.ui.notify("Agent is busy. Run the review when it is idle.", "warning");
    try {
      const payload = parseCommand(args);
      pi.sendUserMessage(`Call code_review_loop with ${JSON.stringify(payload)} and report the final loop status.`);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  };

  pi.registerCommand("code-review-loop", { description: "Review changes: /code-review-loop [options] [files] -- review rules", handler: sendReview });
  pi.registerCommand("agentic-loop", {
    description: "Run a loop: /agentic-loop code-review [options] [files] -- review rules",
    handler: async (args, ctx) => {
      const [name, ...rest] = args.trim().split(/\s+/);
      if (name !== "code-review") return ctx.ui.notify("Usage: /agentic-loop code-review [options]", "warning");
      await sendReview(rest.join(" "), ctx);
    },
  });
}
