# Pi Agentic Loops

Extension package for [Pi](https://github.com/badlogic/pi-mono) with two workflows:

- **Guided implementation** - plan first, implement one approved step at a time, review corrections, then run an independent final audit.
- **Code review loop** - review the current Git diff, filter findings by severity, apply fixes, and verify the result.

## Requirements

- Pi with package support (`pi install --help` must work).
- Git available in `PATH`.
- A model/provider already configured in Pi. Local models are supported; the code-review loop includes a lighter `local` profile.

> Pi extensions execute code with the same system access as Pi. Review third-party extension source before installing it.

## Install

Install globally from GitHub:

```bash
pi install https://github.com/HermesVC/pi-agentic-loops
```

Restart Pi or run this inside an existing Pi session:

```text
/reload
```

Verify the installation:

```bash
pi list
```

Then run this inside Pi:

```text
/agentic-loops
```

Pi should report that the `guided` and `code-review` workflows are available.

### Project-local installation

To enable the package only for the current project:

```bash
pi install https://github.com/HermesVC/pi-agentic-loops -l
```

### Install from a local clone

```bash
git clone https://github.com/HermesVC/pi-agentic-loops.git
cd pi-agentic-loops
pi install .
```

Do **not** pass `pi-setup-*.tgz` to `pi -e`: Pi loads extension source files or package directories, not npm tarballs as extension entrypoints.

## Guided Implementation

Start a task:

```text
/guided Implement request caching for the API client
```

The model investigates the repository in read-only mode, asks blocking questions, and proposes a short plan. Approve it with `+` or:

```text
/approve-plan
```

Only the first step is implemented. After each implementation turn:

- `/next` accepts the current step and starts the next one.
- `/adjust <instruction>` runs a correction pass without accepting or advancing the current step.
- `/guided-status` shows the saved plan and progress.
- `/finish` runs an independent audit after every step is accepted.
- `/guided-exit` leaves guided mode and keeps existing file changes.

`/guided-cancel` remains an alias for `/guided-exit`. Progress is persisted in the Pi session, so the workflow survives session resume and context compaction.

## Code Review Loop

Review the current staged, unstaged, and untracked Git changes:

```text
/code-review-loop
```

For a medium-sized local model:

```text
/code-review-loop --profile local
```

Fix only critical findings:

```text
/code-review-loop --profile local --severity critical_only
```

Pass custom review rules after `--`:

```text
/code-review-loop --severity medium_and_above -- Check backward compatibility and do not change public API contracts
```

Useful options:

- `--severity all|medium_and_above|critical_only`
- `--profile standard|local`
- `--mode fast|strict`
- `--review-only`
- `--validate "npm test"` (repeatable)
- `--timeout <minutes>`
- `--max-lines <number>`

## Update

Update all installed Pi packages:

```bash
pi update --extensions
```

Then restart Pi or run `/reload`.

## Remove

```bash
pi remove https://github.com/HermesVC/pi-agentic-loops
```

Add `-l` when removing a project-local installation.

## Troubleshooting

**Commands are missing after installation**

Run `pi list`, then `/reload`. Use `pi config` to ensure the package extension is enabled.

**Pi reports `Unknown file extension ".tgz"`**

Remove the tarball path from Pi settings and install with the GitHub command above.

**A guided session is stuck**

Run `/guided-status`. `/next` can recover a completed step even if Pi missed the end-of-turn event. Use `/guided-exit` to leave the workflow without reverting files.

## Development

```bash
npm install
npm test
pi -ne -e ./extensions/agentic-loops/index.ts --help
```

The extension entrypoint is `extensions/agentic-loops/index.ts`.
