# Agentic Loops for Pi

An extensible Pi extension for workflows driven by specialized sub-agents. The first built-in loop is a Git-diff-focused code review.

## Available loops

### `code-review`

Runs a closed `review -> fix -> verify` loop over staged, unstaged, and untracked changes. A read-only reviewer identifies actionable findings, then a separate fixer edits the working tree and runs focused validation. The loop reviews the new diff until it is clean, reaches its iteration limit, or detects that no progress was made.

Tool:

```text
code_review_loop(task: string, files?: string[], base?: string, maxDiffChars?: number, maxIterations?: number, applyFixes?: boolean, fixSeverity?: "all" | "medium_and_above" | "critical_only")
```

Commands:

```text
/code-review-loop -- explain the current changes
/code-review-loop src/index.ts src/api.ts -- review error handling
/agentic-loop code-review -- review all current changes
/agentic-loops
```

`base` defaults to `HEAD`. In a repository without a commit, staged and working-tree diffs are collected separately. Untracked files are represented as new-file patches. Diff input is capped at 120,000 characters by default. The loop performs up to three fix rounds and one final verification. Set `applyFixes: false` for review-only mode.

`fixSeverity` controls what the fixer may change:

- `all` fixes every finding (default)
- `medium_and_above` fixes medium, high, and critical findings
- `critical_only` fixes only critical findings

The reviewer labels every finding as `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`. When findings remain but none are allowed by the selected policy, the loop stops with `POLICY_COMPLETE` and returns those findings without modifying them.

Possible final statuses are `CLEAN`, `FINDINGS`, `POLICY_COMPLETE`, `NO_PROGRESS`, and `MAX_ITERATIONS`.

## Architecture

```text
index.ts                 loop catalog and extension entry point
runtime/subagent.ts      shared isolated sub-agent runner
runtime/types.ts         shared loop contracts
loops/code-review.ts     code-review registration and Git diff context
```

Add a loop by exporting an `AgenticLoop` registrar from `loops/` and including it in the catalog in `index.ts`.

## Local installation

Point Pi at this directory, not at an npm `.tgz` file:

```json
{
  "packages": [
    "E:/Software/OpenServer/domains/automations/agentic_loops/extensions/agentic-loops"
  ]
}
```

During development, copy or symlink the whole directory to `~/.pi/agent/extensions/agentic-loops`, then run `/reload` in Pi.
