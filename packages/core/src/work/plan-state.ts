/**
 * Чистое состояние пункта плана комнаты: «выполнен ли пункт», «какая это сдача» и «кому что делать».
 *
 * Модуль без побочных эффектов: только типы из `./types.js`, ни fs, ни `rooms.ts`, ни `plans.ts`, ни `map.ts`.
 * Поэтому его берёт и окно через подпуть `@parley/core/plan-state`, и MCP, и мутации плана. Таблица действий
 * (`planItemDuties`) живёт здесь один раз: свой расчёт «кто должен действовать» в другом месте — дефект.
 */
import type { PlanItem, PlanItemStatus, RoomPlan } from "./types.js";

export function planItemSatisfied(plan: RoomPlan, item: PlanItem): boolean {
  return plan.mode === "checklist"
    ? item.status === "done"
    : item.status === "verified" ||
        (item.status === "done" &&
          Number.isSafeInteger(item.acceptedChecklistRevision) &&
          item.acceptedChecklistRevision! >= 0 &&
          item.acceptedChecklistRevision! < plan.rev);
}

/** Все зависимости пункта (`after`) удовлетворены: `waiting` и `ready` пересчитываются по этому правилу. */
export function planItemReady(plan: RoomPlan, item: PlanItem): boolean {
  return item.after.every((id) => {
    const dependency = plan.items.find((other) => other.id === id);
    return dependency !== undefined && planItemSatisfied(plan, dependency);
  });
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

/** Поля пункта, смена которых делает его другим поручением: работа и доказательства над прежним не переносятся. */
const semantics = (item: PlanItem): string =>
  JSON.stringify([
    item.title,
    item.owner,
    item.scope,
    item.after,
    item.criteria,
    item.verifier,
  ]);

/** Что принятие поправки сбрасывает. `promotionExempt` — `done` Checklist, который повышение до Verified сохраняет. */
export interface PlanChanges {
  changed: Set<number>;
  promotionExempt: Set<number>;
}

/**
 * Изменённые по `semantics` и новые пункты плюс все, кто зависит от них по `after` (транзитивно); из `acceptRoomPlan`.
 * `proposed.items` — пункты после `validateDraft`, `existing` — принятый план той же комнаты.
 */
export function amendmentChanges(
  existing: RoomPlan,
  proposed: RoomPlan,
): PlanChanges {
  const changed = new Set<number>();
  const promotionExempt = new Set<number>();
  for (const item of proposed.items) {
    const previous = existing.items.find((old) => old.id === item.id);
    const sameCore =
      previous &&
      JSON.stringify([
        previous.title,
        previous.owner,
        previous.scope,
        previous.after,
      ]) === JSON.stringify([item.title, item.owner, item.scope, item.after]);
    if (
      existing.mode === "checklist" &&
      proposed.mode === "verified" &&
      existing.acceptedAt !== null &&
      previous?.status === "done" &&
      sameCore
    )
      promotionExempt.add(item.id);
    else if (!previous || semantics(previous) !== semantics(item))
      changed.add(item.id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of proposed.items)
      if (!changed.has(item.id) && item.after.some((id) => changed.has(id))) {
        changed.add(item.id);
        grew = true;
      }
  }
  return { changed, promotionExempt };
}

export interface PlanRemaining {
  /** `null` — первый план комнаты, а не поправка. */
  base: { id: string; rev: number } | null;
  /**
   * Пункты, не удовлетворённые сразу после принятия, в порядке плана. `item` — пункт таким, каким он станет
   * (`item.status === status`); `mark: 'redo'` — пункт был удовлетворён и поправка его сбрасывает.
   */
  items: {
    item: PlanItem;
    status: PlanItemStatus;
    mark: "new" | "changed" | "redo" | null;
  }[];
  /** Удовлетворены после принятия (до него тоже): на карточке не показываются. */
  doneHidden: number;
  /** Незавершённые пункты принятого плана, которые поправка убирает. */
  removed: { id: number; title: string }[];
}

/**
 * Что останется несделанным после принятия `proposed` поверх `active`. Считает так же, как `acceptRoomPlan`:
 * неизменённый пункт сохраняет состояние, изменённый, новый или сброшенный получает `ready` или `waiting`.
 * Пункт `done`, который ждёт проверки, несделанный. Аргументы не меняет.
 */
export function planRemaining(
  active: RoomPlan | undefined,
  proposed: RoomPlan,
): PlanRemaining {
  const base = active?.id === proposed.id ? active : undefined;
  const changes = base && amendmentChanges(base, proposed);
  const after: RoomPlan = {
    ...proposed,
    items: proposed.items.map((item) => {
      const previous = base?.items.find((old) => old.id === item.id);
      if (!base || !changes || !previous || changes.changed.has(item.id))
        return { ...item };
      const kept: PlanItem = {
        ...item,
        status: previous.status,
        evidence: previous.evidence,
        note: previous.note,
        log: previous.log,
      };
      if (previous.progress) kept.progress = previous.progress;
      if (changes.promotionExempt.has(item.id))
        kept.acceptedChecklistRevision = base.rev;
      else if (previous.acceptedChecklistRevision !== undefined)
        kept.acceptedChecklistRevision = previous.acceptedChecklistRevision;
      return kept;
    }),
  };
  for (const item of after.items)
    if (item.status === "waiting" || item.status === "ready")
      item.status = planItemReady(after, item) ? "ready" : "waiting";
  const items: PlanRemaining["items"] = [];
  let doneHidden = 0;
  for (const item of after.items) {
    if (planItemSatisfied(after, item)) {
      doneHidden++;
      continue;
    }
    const previous = base?.items.find((old) => old.id === item.id);
    let mark: PlanRemaining["items"][number]["mark"] = null;
    if (base && changes) {
      if (!previous) mark = "new";
      else if (changes.changed.has(item.id))
        mark = planItemSatisfied(base, previous) ? "redo" : "changed";
    }
    items.push({ item, status: item.status, mark });
  }
  const removed: PlanRemaining["removed"] = [];
  if (base)
    for (const old of base.items)
      if (
        !proposed.items.some((item) => item.id === old.id) &&
        !planItemSatisfied(base, old)
      )
        removed.push({ id: old.id, title: old.title });
  return {
    base: base ? { id: base.id, rev: base.rev } : null,
    items,
    doneHidden,
    removed,
  };
}
