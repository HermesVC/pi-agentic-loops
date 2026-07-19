import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { runSubagent } from "../runtime/subagent.ts";

const DEFAULT_MCP_ROOT = "E:\\Software\\OpenServer\\domains\\vp-mcp";
const DEFAULT_PROJECT_ROOT = "E:\\Software\\OpenServer\\domains\\vp";
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_TIMEOUT_MINUTES = 15;
const EXCLUDED_MODULES = new Set(["debug-techniques", "review", "_shared"]);
const EXCLUDED_BASENAMES = new Set(["readme.md", "usage.md", "contracts.md", "_template.md"]);
const CONTRACT_BASENAMES = new Set([
  "architecture.md",
  "rules.md",
  "hidden-contracts.md",
  "side-effects.md",
  "code-style.md",
]);
const AUDIT_TOOLS = ["read", "grep", "find", "ls"];
const FIXER_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];
const DRY_RUN_FIXER_TOOLS = ["read", "grep", "find", "ls"];

export type LogStatus = "open" | "done";

export interface UpdateMcpInput {
  mcpRoot?: string;
  projectRoot?: string;
  module?: string;
  contracts?: string[];
  maxIterations?: number;
  dryRun?: boolean;
  timeoutMinutes?: number;
}

export interface LogEntry {
  contract: string;
  status: LogStatus;
  problem: string;
  recommendation: string;
}

export interface AuditFinding {
  contract: string;
  problem: string;
  recommendation: string;
}

export interface FixUpdate {
  contract: string;
  status: LogStatus;
  notes: string;
}

export type UpdateMcpStatus =
  | "aligned"
  | "dry_run_complete"
  | "max_iterations_exceeded"
  | "findings_remain";

export interface UpdateMcpResult {
  status: UpdateMcpStatus;
  waves: number;
  modelCalls: number;
  logPath: string;
  auditedContracts: string[];
  openEntries: LogEntry[];
  dryRunNotes: string[];
  durationMs: number;
  stages: Array<{ label: string; durationMs: number }>;
  summary?: string;
}

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
    edit: "editing files",
    write: "writing files",
    bash: "running command",
  };
  return labels[activity] ?? `using ${activity}`;
}

export function formatLogDate(date = new Date()): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

export function logPathFor(mcpRoot: string, date = new Date()): string {
  return join(mcpRoot, "migrate_log", `mcp_update_log_${formatLogDate(date)}.md`);
}

export function contractIdFromPath(contextRoot: string, absolutePath: string): string {
  const rel = relative(contextRoot, absolutePath).replaceAll("\\", "/");
  const withoutExt = rel.replace(/\.md$/i, "");
  return withoutExt.replace(/\/atoms\//, "/");
}

function shouldIncludeFile(contextRoot: string, absolutePath: string): boolean {
  const rel = relative(contextRoot, absolutePath).replaceAll("\\", "/");
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split("/");
  const fileName = parts[parts.length - 1]?.toLowerCase() ?? "";
  if (EXCLUDED_BASENAMES.has(fileName)) return false;
  if (parts.some((part) => part === "profiles" || part === "techniques")) return false;

  const top = parts[0];
  if (parts.length === 1) return CONTRACT_BASENAMES.has(fileName);
  if (EXCLUDED_MODULES.has(top)) return false;
  if (parts.includes("atoms") && fileName.endsWith(".md")) return true;
  return CONTRACT_BASENAMES.has(fileName);
}

function walkMarkdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      out.push(...walkMarkdownFiles(absolute));
      continue;
    }
    if (stat.isFile() && entry.toLowerCase().endsWith(".md")) out.push(absolute);
  }
  return out;
}

export function discoverContracts(mcpRoot: string, input: UpdateMcpInput = {}): string[] {
  const contextRoot = join(mcpRoot, "context");
  const all = walkMarkdownFiles(contextRoot)
    .filter((file) => shouldIncludeFile(contextRoot, file))
    .map((file) => contractIdFromPath(contextRoot, file))
    .sort((a, b) => a.localeCompare(b));

  const wantedModules = input.module?.trim().toLowerCase();
  const wantedContracts = new Set(
    (input.contracts ?? []).map((value) => normalizeContractId(value)).filter(Boolean),
  );

  return all.filter((id) => {
    if (wantedModules && id.split("/")[0]?.toLowerCase() !== wantedModules) return false;
    if (wantedContracts.size) {
      const lowered = id.toLowerCase();
      if (![...wantedContracts].some((wanted) => wanted.toLowerCase() === lowered)) return false;
    }
    return true;
  });
}

export function normalizeContractId(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^context\//i, "")
    .replace(/\.md$/i, "")
    .replace(/\/atoms\//i, "/")
    .replace(/^\/+/, "");
}

export function resolveContractFile(mcpRoot: string, contractId: string): string {
  const normalized = normalizeContractId(contractId);
  const contextRoot = join(mcpRoot, "context");
  const direct = join(contextRoot, `${normalized}.md`);
  if (existsSync(direct)) return direct;

  const parts = normalized.split("/");
  if (parts.length >= 2) {
    const moduleName = parts[0];
    const name = parts.slice(1).join("/");
    const atomPath = join(contextRoot, moduleName, "atoms", `${name}.md`);
    if (existsSync(atomPath)) return atomPath;
  }
  return direct;
}

export function parseLogMarkdown(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const sections = text.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const contract = normalizeContractId(lines[0] ?? "");
    if (!contract) continue;
    const body = lines.slice(1).join("\n");
    const statusMatch = body.match(/^\s*-\s*Status:\s*(open|done)\s*$/im);
    const problemMatch = body.match(/^\s*-\s*Problem:\s*([\s\S]*?)(?=^\s*-\s*(?:Recommendation|Status):|\Z)/im);
    const recommendationMatch = body.match(/^\s*-\s*Recommendation:\s*([\s\S]*?)(?=^\s*-\s*(?:Problem|Status):|\Z)/im);
    entries.push({
      contract,
      status: statusMatch?.[1]?.toLowerCase() === "done" ? "done" : "open",
      problem: (problemMatch?.[1] ?? "").trim(),
      recommendation: (recommendationMatch?.[1] ?? "").trim(),
    });
  }
  return entries;
}

export function renderLogMarkdown(dateLabel: string, entries: LogEntry[]): string {
  const lines = [
    `# MCP Update Log — ${dateLabel}`,
    "",
    "Statuses: `open` = needs work, `done` = verified aligned. Re-audits must not reopen or rewrite `done` entries.",
    "",
  ];
  for (const entry of entries) {
    lines.push(`## ${entry.contract}`);
    lines.push(`- Status: ${entry.status}`);
    lines.push(`- Problem: ${entry.problem || "(none)"}`);
    lines.push(`- Recommendation: ${entry.recommendation || "(none)"}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function mergeAuditIntoLog(existing: LogEntry[], findings: AuditFinding[], auditedIds: string[]): LogEntry[] {
  const byId = new Map(existing.map((entry) => [entry.contract, { ...entry }]));
  const audited = new Set(auditedIds.map(normalizeContractId));
  const findingIds = new Set(findings.map((finding) => normalizeContractId(finding.contract)));

  for (const finding of findings) {
    const id = normalizeContractId(finding.contract);
    const previous = byId.get(id);
    if (previous?.status === "done") continue;
    byId.set(id, {
      contract: id,
      status: "open",
      problem: finding.problem.trim(),
      recommendation: finding.recommendation.trim(),
    });
  }

  for (const id of audited) {
    if (findingIds.has(id)) continue;
    const previous = byId.get(id);
    if (!previous) continue;
    if (previous.status === "done") continue;
    byId.set(id, {
      ...previous,
      status: "done",
      problem: previous.problem || "No mismatch found on re-audit.",
      recommendation: previous.recommendation || "No further MCP changes required.",
    });
  }

  return [...byId.values()].sort((a, b) => a.contract.localeCompare(b.contract));
}

export function applyFixUpdates(existing: LogEntry[], updates: FixUpdate[]): LogEntry[] {
  const byId = new Map(existing.map((entry) => [entry.contract, { ...entry }]));
  for (const update of updates) {
    const id = normalizeContractId(update.contract);
    const previous = byId.get(id);
    if (!previous || previous.status === "done") continue;
    // Only audit may mark done after verification; fixer notes stay open for the next wave.
    byId.set(id, {
      ...previous,
      status: "open",
      recommendation: update.notes.trim()
        ? `${previous.recommendation}\nFixer notes: ${update.notes.trim()}`.trim()
        : previous.recommendation,
    });
  }
  return [...byId.values()].sort((a, b) => a.contract.localeCompare(b.contract));
}

export function openEntries(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.status !== "done");
}

export function ensureLogFile(logPath: string, dateLabel: string): LogEntry[] {
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) {
    writeFileSync(logPath, renderLogMarkdown(dateLabel, []), "utf8");
    return [];
  }
  return parseLogMarkdown(readFileSync(logPath, "utf8"));
}

export function writeLogFile(logPath: string, dateLabel: string, entries: LogEntry[]): void {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, renderLogMarkdown(dateLabel, entries), "utf8");
}

export function jsonFromResponse(text: string): any {
  const fenced = text.match(/```(?:[a-z][\w+-]*)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  const preview = source.replace(/\s+/g, " ").trim().slice(0, 300) || "[empty response]";
  if (start < 0 || end < start) throw new Error(`Agent returned no JSON object. Response preview: ${preview}`);
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent returned invalid JSON object: ${detail}. Response preview: ${preview}`);
  }
}

function normalizeFindings(value: unknown): AuditFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: any) => {
    const contract = normalizeContractId(String(raw?.contract ?? ""));
    const problem = String(raw?.problem ?? "").trim();
    const recommendation = String(raw?.recommendation ?? "").trim();
    if (!contract || !problem || !recommendation) return [];
    return [{ contract, problem, recommendation }];
  });
}

function normalizeFixUpdates(value: unknown): FixUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: any) => {
    const contract = normalizeContractId(String(raw?.contract ?? ""));
    const status = String(raw?.status ?? "open").toLowerCase() === "done" ? "done" : "open";
    const notes = String(raw?.notes ?? raw?.description ?? "").trim();
    if (!contract) return [];
    return [{ contract, status, notes }];
  });
}

export function auditPrompt(options: {
  mcpRoot: string;
  projectRoot: string;
  workspaceRoot: string;
  contracts: string[];
  logPath: string;
}): string {
  const list = options.contracts
    .map((id) => `- ${id} -> ${resolveContractFile(options.mcpRoot, id)}`)
    .join("\n");
  return [
    "You are auditing MCP documentation against the real VP project code.",
    "Iterate through EVERY listed contract. For each one:",
    "1. Read the contract file under the MCP root.",
    "2. Verify whether the real VP project code matches that contract.",
    "3. If it matches, move to the next contract.",
    "4. If it does not match, record a finding with the contract name, a concrete problem description (what is missing or wrong), and a surgical recommendation.",
    "",
    "Rules:",
    `- MCP root: ${options.mcpRoot}`,
    `- VP project root: ${options.projectRoot}`,
    `- Workspace root (tool cwd): ${options.workspaceRoot}`,
    `- Update log path (orchestrator writes this file; do not edit it): ${options.logPath}`,
    "- Never modify any files. Read-only tools only.",
    "- Never modify VP project code.",
    "- Focus on factual drift between MCP docs and VP code. Ignore style nits.",
    "- Keep findings specific and token-efficient.",
    "",
    "Return JSON only:",
    '{"aligned":true|false,"findings":[{"contract":"module/name","problem":"...","recommendation":"..."}]}',
    "Use {\"aligned\":true,\"findings\":[]} when every listed contract matches.",
    "",
    "Contracts to audit:",
    list || "- (none)",
  ].join("\n");
}

export function fixerPrompt(options: {
  mcpRoot: string;
  projectRoot: string;
  workspaceRoot: string;
  logPath: string;
  entries: LogEntry[];
  dryRun: boolean;
}): string {
  const open = openEntries(options.entries);
  const payload = open.map(({ contract, problem, recommendation }) => ({ contract, problem, recommendation }));
  if (options.dryRun) {
    return [
      "You are preparing surgical MCP fixes in DRY-RUN mode.",
      "Read the open log entries and the related MCP/VP files as needed.",
      "Do NOT edit any files. Do NOT commit or push.",
      "For each open entry, describe exactly how you would fix the MCP docs with maximally surgical edits.",
      "MCP exists to add precision while saving tokens — never bloat docs.",
      "Never touch VP project code.",
      "",
      `- MCP root: ${options.mcpRoot}`,
      `- VP project root: ${options.projectRoot}`,
      `- Workspace root: ${options.workspaceRoot}`,
      `- Log path: ${options.logPath}`,
      "",
      "Skip every entry that is already status=done.",
      "Return JSON only:",
      '{"updates":[{"contract":"module/name","status":"open","notes":"textual description of the surgical MCP edit you would make"}]}',
      "",
      `Open log entries:\n${JSON.stringify(payload, null, 2)}`,
    ].join("\n");
  }
  return [
    "You are applying surgical fixes to MCP documentation so it matches the VP project.",
    "Read the open log entries, inspect MCP + VP code, then edit ONLY files under the MCP root.",
    "Constraints:",
    "- Maximally surgical edits only. Do not bloat MCP. Prefer tightening or correcting existing text over adding long new sections.",
    "- Never modify VP project files.",
    "- Do not stage, commit, or push.",
    "- Skip entries with status=done.",
    "- Leave every handled entry open in your JSON: the next audit wave verifies and marks done.",
    "",
    `- MCP root: ${options.mcpRoot}`,
    `- VP project root: ${options.projectRoot}`,
    `- Workspace root: ${options.workspaceRoot}`,
    `- Log path (orchestrator owns statuses; still return JSON updates): ${options.logPath}`,
    "",
    "Return JSON only:",
    '{"updates":[{"contract":"module/name","status":"open","notes":"what changed"}]}',
    "",
    `Open log entries:\n${JSON.stringify(payload, null, 2)}`,
  ].join("\n");
}

const AUDITOR_SYSTEM = "You are a precise MCP-to-code auditor. Verify contracts against real VP code with tools. Prefer missing a weak suspicion over a false mismatch. JSON only.";
const FIXER_SYSTEM = "You are a surgical MCP documentation engineer. Edit only vp-mcp files, keep changes minimal for token economy, never touch VP code, never commit.";
const DRY_RUN_FIXER_SYSTEM = "You describe surgical MCP fixes without editing files. Never touch VP code. JSON only.";

function workspaceRootFor(mcpRoot: string, projectRoot: string): string {
  const mcp = resolve(mcpRoot);
  const project = resolve(projectRoot);
  const mcpParts = mcp.split(/[/\\]/).filter(Boolean);
  const projectParts = project.split(/[/\\]/).filter(Boolean);
  const shared: string[] = [];
  for (let index = 0; index < Math.min(mcpParts.length, projectParts.length); index++) {
    if (mcpParts[index]?.toLowerCase() !== projectParts[index]?.toLowerCase()) break;
    shared.push(mcpParts[index]!);
  }
  if (!shared.length) return dirname(mcp);
  const isUnc = mcp.startsWith("\\\\");
  if (isUnc) return `\\\\${shared.join("\\")}`;
  const drive = /^[a-zA-Z]:/.test(mcp) ? `${mcp.slice(0, 2)}${sep}` : sep;
  return resolve(drive, ...shared);
}

async function runUpdateMcpLoop(
  input: UpdateMcpInput,
  signal: AbortSignal | undefined,
  stage: (text: string) => void,
): Promise<UpdateMcpResult> {
  const startedAt = Date.now();
  const stages: Array<{ label: string; durationMs: number }> = [];
  const mcpRoot = resolve(input.mcpRoot?.trim() || DEFAULT_MCP_ROOT);
  const projectRoot = resolve(input.projectRoot?.trim() || DEFAULT_PROJECT_ROOT);
  const workspaceRoot = workspaceRootFor(mcpRoot, projectRoot);
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMs = (input.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
  const dryRun = Boolean(input.dryRun);
  const dateLabel = formatLogDate();
  const logPath = logPathFor(mcpRoot);
  let entries = ensureLogFile(logPath, dateLabel);
  let modelCalls = 0;
  let waves = 0;
  const auditedContracts: string[] = [];
  const dryRunNotes: string[] = [];

  const finish = (result: Omit<UpdateMcpResult, "durationMs" | "stages" | "logPath" | "openEntries">): UpdateMcpResult => ({
    ...result,
    logPath,
    openEntries: openEntries(entries),
    durationMs: Date.now() - startedAt,
    stages,
  });

  const call = async (label: string, prompt: string, systemPrompt: string, tools: string[]) => {
    modelCalls++;
    const callNumber = modelCalls;
    const callStartedAt = Date.now();
    stage(`${label} | call ${callNumber} | starting`);
    try {
      return await runSubagent({
        cwd: workspaceRoot,
        prompt,
        systemPrompt,
        tools,
        signal,
        timeoutMs,
        onProgress: ({ activity, elapsedMs }) => {
          stage(`${label} | call ${callNumber} | ${activityLabel(activity)} | ${formatDuration(elapsedMs)}`);
        },
      });
    } finally {
      stages.push({ label, durationMs: Date.now() - callStartedAt });
    }
  };

  const allScoped = discoverContracts(mcpRoot, input);
  if (!allScoped.length) {
    return finish({
      status: "aligned",
      waves: 0,
      modelCalls: 0,
      auditedContracts: [],
      dryRunNotes: [],
      summary: "No contracts matched the requested scope.",
    });
  }

  for (let wave = 1; wave <= maxIterations; wave++) {
    waves = wave;
    const targets = wave === 1
      ? allScoped
      : openEntries(entries).map((entry) => entry.contract).filter((id) => allScoped.includes(id));

    if (!targets.length) {
      return finish({
        status: "aligned",
        waves,
        modelCalls,
        auditedContracts,
        dryRunNotes,
        summary: "MCP matches the VP project for the selected scope.",
      });
    }

    stage(`Wave ${wave}/${maxIterations} | auditing ${targets.length} contract(s)`);
    const auditResponse = jsonFromResponse(await call(
      `Wave ${wave} audit`,
      auditPrompt({ mcpRoot, projectRoot, workspaceRoot, contracts: targets, logPath }),
      AUDITOR_SYSTEM,
      AUDIT_TOOLS,
    ));
    const findings = normalizeFindings(auditResponse.findings);
    auditedContracts.push(...targets);
    entries = mergeAuditIntoLog(entries, findings, targets);
    writeLogFile(logPath, dateLabel, entries);

    const stillOpen = openEntries(entries).filter((entry) => allScoped.includes(entry.contract));
    if (!stillOpen.length) {
      return finish({
        status: "aligned",
        waves,
        modelCalls,
        auditedContracts,
        dryRunNotes,
        summary: "All audited contracts match the VP project.",
      });
    }

    stage(`Wave ${wave}/${maxIterations} | fixing ${stillOpen.length} open issue(s)${dryRun ? " (dry-run)" : ""}`);
    const fixResponse = jsonFromResponse(await call(
      `Wave ${wave} fix${dryRun ? " dry-run" : ""}`,
      fixerPrompt({ mcpRoot, projectRoot, workspaceRoot, logPath, entries, dryRun }),
      dryRun ? DRY_RUN_FIXER_SYSTEM : FIXER_SYSTEM,
      dryRun ? DRY_RUN_FIXER_TOOLS : FIXER_TOOLS,
    ));
    const updates = normalizeFixUpdates(fixResponse.updates);
    if (dryRun) {
      for (const update of updates) {
        dryRunNotes.push(`${update.contract}: ${update.notes || "(no notes)"}`);
      }
      return finish({
        status: "dry_run_complete",
        waves,
        modelCalls,
        auditedContracts,
        dryRunNotes,
        summary: `Dry-run complete with ${stillOpen.length} open issue(s). No MCP files were modified.`,
      });
    }

    entries = applyFixUpdates(entries, updates);
    writeLogFile(logPath, dateLabel, entries);
  }

  return finish({
    status: "max_iterations_exceeded",
    waves,
    modelCalls,
    auditedContracts,
    dryRunNotes,
    summary: `Exceeded ${maxIterations} audit+fix waves. Human review required. Open issues remain in ${logPath}`,
  });
}

function formatResult(result: UpdateMcpResult): string {
  const lines = [
    `Status: ${result.status.toUpperCase()}`,
    `Waves: ${result.waves}`,
    `Model calls: ${result.modelCalls}`,
    `Log: ${result.logPath}`,
    `Audited contracts: ${result.auditedContracts.length}`,
    `Open issues: ${result.openEntries.length}`,
    `Total duration: ${formatDuration(result.durationMs)}`,
  ];
  if (result.stages.length) {
    lines.push(`Stages: ${result.stages.map((item) => `${item.label} ${formatDuration(item.durationMs)}`).join("; ")}`);
  }
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  if (result.dryRunNotes.length) {
    lines.push("", "Dry-run fix descriptions:");
    for (const note of result.dryRunNotes) lines.push(`- ${note}`);
  }
  if (result.openEntries.length) {
    lines.push("", JSON.stringify({ open: result.openEntries }, null, 2));
  }
  return lines.join("\n");
}

export function parseUpdateMcpCommand(args: string): UpdateMcpInput {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, "")) ?? [];
  const input: UpdateMcpInput = {};
  const contracts: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const value = tokens[index + 1];
    if (token === "--mcp-root" && value) { input.mcpRoot = value; index++; }
    else if (token === "--project-root" && value) { input.projectRoot = value; index++; }
    else if (token === "--module" && value) { input.module = value; index++; }
    else if (token === "--contract" && value) { contracts.push(value); index++; }
    else if (token === "--iterations" && value) { input.maxIterations = Number(value); index++; }
    else if (token === "--timeout" && value) { input.timeoutMinutes = Number(value); index++; }
    else if (token === "--dry-run") input.dryRun = true;
    else if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    else contracts.push(token);
  }
  if (contracts.length) input.contracts = contracts.map(normalizeContractId);
  return input;
}

export function registerUpdateMcpLoop(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "update_mcp_loop",
    label: "Update MCP Loop",
    description: "Audits vp-mcp contracts against the VP project, logs drift, and applies surgical MCP-only fixes.",
    parameters: Type.Object({
      mcpRoot: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String()),
      module: Type.Optional(Type.String()),
      contracts: Type.Optional(Type.Array(Type.String())),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 5 })),
      dryRun: Type.Optional(Type.Boolean()),
      timeoutMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })),
    }),
    async execute(_id, params: UpdateMcpInput, signal, onUpdate) {
      try {
        const result = await runUpdateMcpLoop(params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }] }));
        return { content: [{ type: "text", text: formatResult(result) }], isError: result.status === "max_iterations_exceeded" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Update MCP loop failed: ${message}` }], isError: true };
      }
    },
  });

  const sendLoop = async (args: string, ctx: any) => {
    if (!ctx.isIdle()) return ctx.ui.notify("Agent is busy. Run the loop when it is idle.", "warning");
    try {
      const payload = parseUpdateMcpCommand(args);
      pi.sendUserMessage(`Call update_mcp_loop with ${JSON.stringify(payload)} and report the final loop status.`);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  };

  pi.registerCommand("update-mcp-loop", {
    description: "Audit/fix vp-mcp vs VP: /update-mcp-loop [--dry-run] [--module core] [--contract core/known-typos]",
    handler: sendLoop,
  });
}

export async function sendUpdateMcpLoopCommand(pi: ExtensionAPI, args: string, ctx: any): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy. Run the loop when it is idle.", "warning");
    return;
  }
  try {
    const payload = parseUpdateMcpCommand(args);
    pi.sendUserMessage(`Call update_mcp_loop with ${JSON.stringify(payload)} and report the final loop status.`);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
  }
}
