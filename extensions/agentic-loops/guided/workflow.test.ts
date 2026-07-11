import assert from "node:assert/strict";
import { buildGuidedContext, findLatestPlan, isReadOnlyBash, parsePlan } from "./workflow.ts";

const fixtures = [
  ["1. Backend change\n2. Frontend change", ["Backend change", "Frontend change"]],
  ["### Step 1: Create model\n### Step 2: Add controller", ["Create model", "Add controller"]],
  ["**Крок 1 — Створити модель**\n**Крок 2 — Додати контролер**", ["Створити модель", "Додати контролер"]],
  ["Шаг 1. Изменить API\nШаг 2. Проверить UI", ["Изменить API", "Проверить UI"]],
] as const;

for (const [source, expected] of fixtures) {
  assert.deepEqual(parsePlan(source).map((step) => step.text), expected);
}

const transcriptPlan = findLatestPlan([
  "Будь ласка, підтвердьте застосування змін через UI.",
  "### Крок 1 — Створити модель\n### Крок 2 — Додати контролер\n### Крок 3 — Перевірити інтеграцію",
]);
assert.deepEqual(transcriptPlan.map((step) => step.text), [
  "Створити модель",
  "Додати контролер",
  "Перевірити інтеграцію",
]);

for (const command of [
  "git status --short", "git diff HEAD", "git log -10", "git blame src/app.ts", "git grep TODO",
  "git rev-parse --show-toplevel", "git ls-files", "git branch -a", "git tag --list", "git stash show",
  "git worktree list", "git config --get remote.origin.url",
]) {
  assert.equal(isReadOnlyBash(command), true, `expected read-only command: ${command}`);
}

for (const command of [
  "git add .", "git commit -m test", "git checkout main", "git branch -D main", "git tag -d v1",
  "git branch new-feature", "git tag v1.0.0",
  "git stash pop", "git worktree remove ../copy", "git config user.name test", "git diff > patch.txt",
]) {
  assert.equal(isReadOnlyBash(command), false, `expected blocked command: ${command}`);
}

const executionContext = buildGuidedContext({
  phase: "executing",
  task: "Preserve product behavior",
  currentStep: 1,
  plan: [
    { text: "Add data model", status: "done" },
    { text: "Wire controller", status: "pending" },
    { text: "Validate integration", status: "pending" },
  ],
  notes: ["Keep the legacy API compatible"],
});
for (const required of [
  "Phase: executing", "Task: Preserve product behavior", "Progress: 2/3", "[x] 1. Add data model",
  "[>] 2. Wire controller", "Keep the legacy API compatible", "Implement exactly one approved step",
]) {
  assert.ok(executionContext.includes(required), `missing guided context obligation: ${required}`);
}

const reviewContext = buildGuidedContext({
  phase: "review", task: "Review gate", currentStep: 0,
  plan: [{ text: "Make one change", status: "pending" }], notes: [],
});
assert.ok(reviewContext.includes("Stay read-only"));
assert.ok(reviewContext.includes("Approval starts exactly one step"));

console.log(`guided workflow: ${fixtures.length + 1} plan fixtures, 23 shell policies, and prompt obligations passed`);
