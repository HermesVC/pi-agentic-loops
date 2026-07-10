# Agentic Loops for Pi

An extensible Pi extension for workflows driven by specialized sub-agents.

## Code review loop

The code-review loop works on staged, unstaged, and untracked Git changes. It uses structured findings with stable IDs, severity, confidence, and verified evidence.

### Fast mode

Default workflow with one fix round and three model calls:

```text
full diff review -> fix confirmed findings -> targeted verification
```

```text
/code-review-loop
/code-review-loop --severity critical_only
/code-review-loop --mode fast --severity medium_and_above -- Ignore formatting
/code-review-loop --severity critical_only --validate "npm test" --validate "npm run typecheck"
```

### Strict mode

Adds an independent evidence check and a final regression review:

```text
review -> evidence check -> fix -> targeted verification -> final review
```

```text
/code-review-loop --mode strict --severity medium_and_above
```

Text after the standalone `--` is passed as explicit review rules to every agent.

While the loop runs, Pi updates a live status line every five seconds. It shows the current stage, model-call number, elapsed time, and whether the sub-agent is thinking, reading, searching, editing, or running a command. The final report includes total and per-stage durations.

### Options

- `--mode fast|strict` (default: `fast`)
- `--severity all|medium_and_above|critical_only` (default: `all`)
- `--iterations 1|2` (default: `1`)
- `--review-only`
- `--base <git-ref>`
- `--max-calls <number>`
- `--timeout <minutes>` per sub-agent
- `--max-lines <number>` total changed-line guard
- `--validate <command>` repeatable deterministic validation command
- `--validation-timeout <minutes>` per validation command (default: `5`)
- positional file paths separated by spaces or commas

Tool parameters mirror these options:

```text
code_review_loop(
  task?, reviewRules?, files?, base?, maxDiffChars?,
  maxIterations?, applyFixes?, fixSeverity?, mode?,
  maxModelCalls?, timeoutMinutes?, maxChangedLines?
  validationCommands?, validationTimeoutMinutes?
)
```

When validation commands are supplied, the loop runs them before the first fix as a baseline and after every fix round. A command that passed at baseline but fails afterward stops the loop with `VALIDATION_FAILED`; pre-existing failures are reported without being misclassified as regressions.

The read-only agents have `read`, `grep`, `find`, and `ls` so they can verify repository contracts instead of guessing from the patch. The fixer is instructed to edit only files already present in the reviewed diff. The loop stops on no progress, model-call exhaustion, timeout, or change-limit violations.

## Architecture

```text
index.ts                 loop catalog and extension entry point
runtime/subagent.ts      isolated sub-agent runner with timeout
runtime/types.ts         shared loop contracts
loops/code-review.ts     structured review/fix/verify workflow
```

Add a loop by exporting an `AgenticLoop` registrar from `loops/` and including it in `index.ts`.

## Local installation

Point Pi at the extension directory, never at an npm `.tgz` file:

```json
{
  "packages": [
    "E:/Software/OpenServer/domains/automations/agentic_loops/extensions/agentic-loops"
  ]
}
```

During development, copy or symlink the whole directory to `~/.pi/agent/extensions/agentic-loops`, then run `/reload` in Pi.
