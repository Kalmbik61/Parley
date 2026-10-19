/**
 * Чистое состояние пункта плана комнаты: «выполнен ли пункт», «какая это сдача» и «кому что делать».
 *
 * Модуль без побочных эффектов: только типы из `./types.js`, ни fs, ни `rooms.ts`, ни `plans.ts`, ни `map.ts`.
 * Поэтому его берёт и окно через подпуть `@parley/core/plan-state`, и MCP, и мутации плана. Таблица действий
 * (`planItemDuties`) живёт здесь один раз: свой расчёт «кто должен действовать» в другом месте — дефект.
 */
import type { PlanItem, RoomPlan } from "./types.js";

export function planItemSatisfied(plan: RoomPlan, item: PlanItem): boolean {
  return plan.mode === "checklist"
    ? item.status === "done"
    : item.status === "verified" ||
        (item.status === "done" &&
          Number.isSafeInteger(item.acceptedChecklistRevision) &&
          item.acceptedChecklistRevision! >= 0 &&
          item.acceptedChecklistRevision! < plan.rev);
}

/**
 * Номер сдачи: индекс последней записи `done` в `log` плюс один. Совпадает с `occurrence` письма `verify`
 * сразу после сдачи. `null`, пока пункт ни разу не сдавали.
 */
export function planSubmission(item: PlanItem): number | null {
  for (let index = item.log.length - 1; index >= 0; index--)
    if (item.log[index]!.status === "done") return index + 1;
  return null;
}

export type PlanDutyRole = "owner" | "verifier" | "lead";
export type PlanDutyAction =
  | "start"
  | "continue"
  | "rework"
  | "verify"
  | "resolve-block"
  | "wait";
/** Чего ждёт участник, когда его действие — `wait`. */
export type PlanWaitingFor =
  | { kind: "blocked"; note: string | null }
  | { kind: "dependencies"; items: number[] }
  | { kind: "verification"; by: string | null }
  | { kind: "submission"; by: string };
export interface PlanDuty {
  role: PlanDutyRole;
  sessionId: string;
  action: PlanDutyAction;
  waitingFor: PlanWaitingFor | null;
}

/**
 * Обязанности по одному пункту, в порядке owner, verifier, lead. Выполненный пункт обязанностей не даёт.
 * Лид (`liveLeadId` не `null`) нужен только заблокированному пункту; кто жив и состоит в комнате — забота вызывающего.
 */
export function planItemDuties(
  plan: RoomPlan,
  item: PlanItem,
  liveLeadId: string | null,
): PlanDuty[] {
  if (planItemSatisfied(plan, item)) return [];
  const duties: PlanDuty[] = [];
  const duty = (
    role: PlanDutyRole,
    sessionId: string,
    action: PlanDutyAction,
    waitingFor: PlanWaitingFor | null = null,
  ): void => {
    duties.push({ role, sessionId, action, waitingFor });
  };
  const verified = plan.mode === "verified";
  if (item.status === "ready") duty("owner", item.owner, "start");
  else if (item.status === "in_progress") duty("owner", item.owner, "continue");
  else if (item.status === "returned") duty("owner", item.owner, "rework");
  else if (item.status === "blocked")
    duty("owner", item.owner, "wait", { kind: "blocked", note: item.note });
  else if (item.status === "waiting")
    duty("owner", item.owner, "wait", {
      kind: "dependencies",
      items: item.after.filter((id) => {
        const dependency = plan.items.find((other) => other.id === id);
        return !dependency || !planItemSatisfied(plan, dependency);
      }),
    });
  else if (item.status === "done" && verified)
    duty("owner", item.owner, "wait", {
      kind: "verification",
      by: item.verifier,
    });
  if (verified && item.verifier !== null && item.verifier !== item.owner) {
    if (item.status === "done") duty("verifier", item.verifier, "verify");
    else
      duty("verifier", item.verifier, "wait", {
        kind: "submission",
        by: item.owner,
      });
  }
  if (liveLeadId !== null && item.status === "blocked")
    duty("lead", liveLeadId, "resolve-block");
  return duties;
}
