import type { CheckResult, PlanAttempt, RoomPlan } from "@parley/core";

/** Последняя попытка пункта — с наибольшим `n`; `undefined` у неавтономного плана и у пункта без попыток. */
export function lastAttempt(plan: RoomPlan, itemId: number): PlanAttempt | undefined {
  return plan.mode === "autonomous"
    ? plan.autonomous?.attempts.filter((row) => row.item === itemId).sort((a, b) => b.n - a.n)[0]
    : undefined;
}

/** Последняя записанная проверка попытки: завершённые операции `check`, результат этой попытки, самая поздняя по `at`. */
export function latestAttemptCheck(plan: RoomPlan, attempt: PlanAttempt): CheckResult | undefined {
  return plan.autonomous?.ops
    .filter((op) => op.kind === "check" && op.state === "done")
    .map((op) => op.result?.checkResult as CheckResult | undefined)
    .filter((row): row is CheckResult => !!row && row.attemptId === attempt.id && attempt.checks.includes(row.id))
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
}

/** Текст проверки, как в списке плана: `specId → verdict · сводка до 160 знаков`; `''`, если проверки нет. */
export function checkLine(check: CheckResult | undefined): string {
  if (!check) return "";
  const summary = check.summary.replace(/\s+/g, " ");
  return `${check.specId} → ${check.verdict} · ${summary.slice(0, 160)}${summary.length > 160 ? "…" : ""}`;
}
