import assert from "node:assert/strict";
import { findLatestPlan, parsePlan } from "./workflow.ts";

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

console.log(`guided plan parser: ${fixtures.length + 1} fixtures passed`);
