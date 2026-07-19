import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFixUpdates,
  auditPrompt,
  contractIdFromPath,
  discoverContracts,
  fixerPrompt,
  formatLogDate,
  jsonFromResponse,
  logPathFor,
  mergeAuditIntoLog,
  normalizeContractId,
  openEntries,
  parseLogMarkdown,
  parseUpdateMcpCommand,
  renderLogMarkdown,
  resolveContractFile,
} from "./update-mcp.ts";

const KNOWN_TYPOS_FIXTURE = `# known-typos (P2)

**Module:** core

## Contract

| Issue | Location |
|-------|----------|
| \`StoneAssebblies\` | \`stone/js/assemblies.js:873\` |
| \`FasadsaveToProject\` casing | \`fasad/js/main.js:1504, 1522\` |

## Breaks

grep/rename misses callers; RPC string mismatch.

## Check

grep exact strings before "fixing" typos — may be load-bearing.
`;

function makeFixtureMcp(): string {
  const root = mkdtempSync(join(tmpdir(), "update-mcp-"));
  const atomDir = join(root, "context", "core", "atoms");
  mkdirSync(atomDir, { recursive: true });
  mkdirSync(join(root, "context", "core"), { recursive: true });
  mkdirSync(join(root, "context", "debug-techniques", "techniques"), { recursive: true });
  mkdirSync(join(root, "context", "review", "profiles"), { recursive: true });
  writeFileSync(join(atomDir, "known-typos.md"), KNOWN_TYPOS_FIXTURE, "utf8");
  writeFileSync(join(root, "context", "core", "architecture.md"), "# core architecture\n", "utf8");
  writeFileSync(join(root, "context", "debug-techniques", "techniques", "docker.md"), "# technique\n", "utf8");
  writeFileSync(join(root, "context", "review", "profiles", "style-php.md"), "# review profile\n", "utf8");
  writeFileSync(join(root, "context", "USAGE.md"), "# usage\n", "utf8");
  return root;
}

const mcpRoot = makeFixtureMcp();
const contextRoot = join(mcpRoot, "context");

assert.equal(normalizeContractId("context/core/atoms/known-typos.md"), "core/known-typos");
assert.equal(
  contractIdFromPath(contextRoot, join(contextRoot, "core", "atoms", "known-typos.md")),
  "core/known-typos",
);
assert.equal(
  resolveContractFile(mcpRoot, "core/known-typos"),
  join(contextRoot, "core", "atoms", "known-typos.md"),
);

const discovered = discoverContracts(mcpRoot);
assert.deepEqual(discovered, ["core/architecture", "core/known-typos"]);
assert.deepEqual(discoverContracts(mcpRoot, { contracts: ["core/known-typos"] }), ["core/known-typos"]);
assert.deepEqual(discoverContracts(mcpRoot, { module: "core", contracts: ["core/known-typos"] }), ["core/known-typos"]);

const dateLabel = formatLogDate(new Date("2026-07-19T12:00:00"));
assert.equal(dateLabel, "19.07.2026");
assert.equal(logPathFor(mcpRoot, new Date("2026-07-19T12:00:00")), join(mcpRoot, "migrate_log", "mcp_update_log_19.07.2026.md"));

const rendered = renderLogMarkdown(dateLabel, [{
  contract: "core/known-typos",
  status: "open",
  problem: "Assemblies typo location drifted",
  recommendation: "Update line reference only",
}]);
const parsed = parseLogMarkdown(rendered);
assert.equal(parsed.length, 1);
assert.equal(parsed[0]?.contract, "core/known-typos");
assert.equal(parsed[0]?.status, "open");
assert.match(parsed[0]?.problem ?? "", /Assemblies typo/);

const withDone = mergeAuditIntoLog(
  [{
    contract: "core/known-typos",
    status: "done",
    problem: "already fixed",
    recommendation: "keep",
  }],
  [{
    contract: "core/known-typos",
    problem: "should be ignored because done",
    recommendation: "do not reopen",
  }],
  ["core/known-typos"],
);
assert.equal(withDone[0]?.status, "done");
assert.equal(withDone[0]?.problem, "already fixed");

const reopened = mergeAuditIntoLog(
  [{
    contract: "core/known-typos",
    status: "open",
    problem: "old problem",
    recommendation: "old recommendation",
  }],
  [{
    contract: "core/known-typos",
    problem: "Assemblies typo location drifted",
    recommendation: "Update line reference only",
  }],
  ["core/known-typos"],
);
assert.equal(reopened[0]?.problem, "Assemblies typo location drifted");

const cleared = mergeAuditIntoLog(
  [{
    contract: "core/known-typos",
    status: "open",
    problem: "temporary drift",
    recommendation: "fix docs",
  }],
  [],
  ["core/known-typos"],
);
assert.equal(cleared[0]?.status, "done");
assert.equal(openEntries(cleared).length, 0);

const afterFix = applyFixUpdates(reopened, [{
  contract: "core/known-typos",
  status: "done",
  notes: "Corrected line number in the table",
}]);
assert.equal(afterFix[0]?.status, "open", "fixer cannot mark done; audit must verify next wave");
assert.match(afterFix[0]?.recommendation ?? "", /Fixer notes/);

const audit = auditPrompt({
  mcpRoot,
  projectRoot: "E:\\Software\\OpenServer\\domains\\vp",
  workspaceRoot: "E:\\Software\\OpenServer\\domains",
  contracts: ["core/known-typos"],
  logPath: logPathFor(mcpRoot, new Date("2026-07-19T12:00:00")),
});
assert.match(audit, /Iterate through EVERY listed contract/);
assert.match(audit, /core\/known-typos/);
assert.match(audit, /Never modify any files/);
assert.match(audit, /known-typos\.md/);

const dryRunPrompt = fixerPrompt({
  mcpRoot,
  projectRoot: "E:\\Software\\OpenServer\\domains\\vp",
  workspaceRoot: "E:\\Software\\OpenServer\\domains",
  logPath: logPathFor(mcpRoot, new Date("2026-07-19T12:00:00")),
  entries: reopened,
  dryRun: true,
});
assert.match(dryRunPrompt, /DRY-RUN mode/);
assert.match(dryRunPrompt, /Do NOT edit any files/);
assert.match(dryRunPrompt, /textual description of the surgical MCP edit/);
assert.match(dryRunPrompt, /core\/known-typos/);
assert.doesNotMatch(dryRunPrompt, /edit ONLY files under the MCP root/);

const liveFixPrompt = fixerPrompt({
  mcpRoot,
  projectRoot: "E:\\Software\\OpenServer\\domains\\vp",
  workspaceRoot: "E:\\Software\\OpenServer\\domains",
  logPath: logPathFor(mcpRoot, new Date("2026-07-19T12:00:00")),
  entries: reopened,
  dryRun: false,
});
assert.match(liveFixPrompt, /edit ONLY files under the MCP root/);
assert.match(liveFixPrompt, /Never modify VP project files/);
assert.doesNotMatch(dryRunPrompt, /edit ONLY files under the MCP root/);

const dryRunAgentReply = `
Here is the dry-run plan:
\`\`\`json
{
  "updates": [
    {
      "contract": "core/known-typos",
      "status": "open",
      "notes": "I would only update the assemblies.js line number in the table if VP moved the StoneAssebblies identifier; no new sections."
    }
  ]
}
\`\`\`
`;
const dryRunJson = jsonFromResponse(dryRunAgentReply);
assert.equal(dryRunJson.updates[0].contract, "core/known-typos");
assert.match(dryRunJson.updates[0].notes, /only update the assemblies\.js line number/);

const parsedCommand = parseUpdateMcpCommand("--dry-run --module core --contract core/known-typos --iterations 2");
assert.equal(parsedCommand.dryRun, true);
assert.equal(parsedCommand.module, "core");
assert.deepEqual(parsedCommand.contracts, ["core/known-typos"]);
assert.equal(parsedCommand.maxIterations, 2);

writeFileSync(join(mcpRoot, "migrate_log_probe.md"), renderLogMarkdown(dateLabel, reopened), "utf8");
assert.match(readFileSync(join(mcpRoot, "migrate_log_probe.md"), "utf8"), /Status: open/);

console.log("update-mcp: discovery, log statuses, known-typos dry-run prompts, and CLI parsing passed");
