# Agentic Loops for Pi

An extensible Pi extension for workflows driven by specialized sub-agents.

## Guided implementation

Guided mode keeps implementation in the main Pi session while limiting a local model to one approved step at a time.

```text
/guided Add request caching to the API client
```

Pi first enters a read-only planning phase. Discuss requirements normally, then approve the last numbered plan:

```text
/approve-plan
```

The model executes only the first step and stops. Pi writes that step's diff to `.git/pi-guided/step-N.diff`; pre-existing working-tree changes are excluded from the step comparison. After reviewing it, use:

- `/next` to accept the step and run the next one
- `/adjust <instruction>` during review to run a correction pass without accepting or advancing the current step
- `/adjust <instruction>` after the last accepted step to add one reviewed correction pass before the audit
- `/guided-status` to inspect progress
- `/guided-exit` to leave guided mode and keep existing changes (`/guided-cancel` remains an alias)
- `/finish` after accepting every step to run an independent final audit

Planning and review phases block built-in writes and non-read-only shell commands. An `/adjust` correction temporarily enables implementation for one turn, then returns to review without advancing the plan. State and plan progress survive Pi session resume. `/finish` uses the active model in a fresh low-thinking, read-only session and checks the original task, approved plan, repository, and current Git diff without receiving the implementing agent's narrative.

## Code review loop

The code-review loop works on staged, unstaged, and untracked Git changes. It uses structured findings with stable IDs, severity, confidence, and verified evidence.

### Local profile

Tuned for medium local models (for example Qwen 3.6). It uses smaller diffs, compact prompts, thinking disabled on structured calls, and a narrower tool set while preserving the review/fix/check workflow.

```text
compact diff review -> fix -> compact post-fix check
```

```text
/code-review-loop --profile local
/code-review-loop --profile local --severity critical_only
/agentic-loop code-review --profile local -- src/service/foo.php
```

Local defaults:

- diff cap: 40k characters (override with tool `maxDiffChars`)
- severity filter: `medium_and_above`
- one fix round; use `--review-only` to disable edits
- tools: reviewer `read/grep`; fixer `read/grep/edit/write` (no bash)
- model-call budget: 2 for review-only, 4 with one fix round (+ recovery within budget)
- timeout: 5 minutes per sub-agent
- no blind verifier, evidence pass, or final regression review
- review chunks around 12k characters, grouped first by file and then by hunk
- finding-scoped diff context for the fixer and compact post-fix check

`--mode light` remains as a compatibility alias for `--profile local`.

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

The default model-call budget reserves one call for structured-output recovery. If any reviewer or verifier response has no valid JSON object or finishes without final text, the loop retries that exact stage once with a stricter format instruction and thinking disabled so local reasoning models preserve output budget for JSON. The retry is visible in live progress and counts against the budget; a second failure reports the model, stop reason, content types, provider error, or a bounded response preview.

### Options

- `--mode light|fast|strict` (default: `fast`)
- `--profile standard|local` (default: `standard`)
- `--severity all|medium_and_above|critical_only` (default: `all`)
- `--iterations 1|2` (default: `1`)
- `--review-only`
- `--apply-fixes` explicitly enable fix rounds after `--review-only`
- `--base <git-ref>`
- `--max-calls <number>`
- `--timeout <minutes>` per sub-agent
- `--max-lines <number>` total changed-line guard
- `--validate <command>` repeatable deterministic validation command
- `--validation-timeout <minutes>` per validation command (default: `5`)
- `--verifier-model <provider/model>` optional separate verifier model
- positional file paths separated by spaces or commas

Tool parameters mirror these options:

```text
code_review_loop(
  task?, profile?, reviewRules?, files?, base?, maxDiffChars?,
  maxIterations?, applyFixes?, fixSeverity?, mode?,
  maxModelCalls?, timeoutMinutes?, maxChangedLines?,
  validationCommands?, validationTimeoutMinutes?, verifierModel?
)
```

When validation commands are supplied, the loop runs them before the first fix as a baseline and after every fix round. A command that passed at baseline but fails afterward stops the loop with `VALIDATION_FAILED`; pre-existing failures are reported without being misclassified as regressions.

Each fix round is transactional for the reviewed working-tree files. The loop restores the pre-round bytes when the fixer times out, is cancelled, edits files outside the initial diff, exceeds the changed-line limit, or introduces a new validation regression. Successful rounds remain in the working tree. The fixer is forbidden from staging or committing changes so the user's index is left alone.

Fix verification runs in a fresh blind session with a dedicated system prompt and a narrower read/search tool set. It receives untrusted finding claims without the original reviewer's evidence or the fixer's narrative, and classifies every claim as `resolved`, `unresolved`, or `inconclusive` from current-code evidence. Supplying `--verifier-model provider/model` also separates the verifier model; otherwise Pi uses the configured default model in an isolated session.

The read-only agents have `read`, `grep`, `find`, and `ls` so they can verify repository contracts instead of guessing from the patch. The fixer is instructed to edit only files already present in the reviewed diff. The loop stops on no progress, model-call exhaustion, timeout, or change-limit violations.

## Architecture

```text
index.ts                 loop catalog and extension entry point
guided/workflow.ts       approval-gated main-session implementation
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
