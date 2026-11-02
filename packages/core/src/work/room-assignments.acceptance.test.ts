import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { createParleyServer } from "../mcp/tools.js";
import { ASSIGNMENTS_BLOCK_MAX_BYTES } from "./context-budget.js";
import { readLetters } from "./letter-store.js";
import { addSession } from "./map.js";
import { reservePlanEffects } from "./plan-effects.js";
import {
  planItemSatisfied,
  planRemaining,
  planSubmission,
} from "./plan-state.js";
import { assignmentsBlock, planTasksView } from "./plan-tasks.js";
import type { PlanTasksView } from "./plan-tasks.js";
import { resolveProposal } from "./proposals.js";
import { addRoom } from "./rooms.js";
import { buildSessionLayer } from "./session-layer.js";
import { createWork, readMap, updateMap, workPaths } from "./store.js";
import { HUMAN } from "./types.js";
import type { PlanDraft, PlanItem, WorkMap } from "./types.js";

/**
 * Сквозная приёмка заданий комнаты (план 2026-10-19, раздел 6) на уровне ядра: детерминированно, без настоящих агентов.
 * Работают настоящие функции ядра и настоящие обработчики MCP (`createParleyServer`) на временной работе: принятие
 * плана, письма-поручения, `check_inbox`, `plan_tasks`, `plan_update`/`plan_progress`/`plan_submit`/`plan_verify`,
 * слой возобновления и оставшиеся пункты поправки. Окно и хост здесь не участвуют: хост лишь вызывает
 * `reservePlanEffects` под замком карты — это делает `accept` ниже. Письма лежат в своих таблицах, поэтому читаются
 * через `readLetters`, а не из карты.
 *
 * Роли: s-01 ведёт комнату, s-02 владеет всеми пунктами, s-03 проверяет, s-04 — одиночный чат вне комнат.
 */

const MEMBERS = ["s-01", "s-02", "s-03"];
const PLAN = "pl-01";
const HINT = "Reading does not complete assignments; call plan_tasks.";
const SESSIONS = ["Lead", "Owner", "Verifier", "Solo"];

let root = "";
let project = "";
let workId = "";
let previousHome: string | undefined;
const clients: Client[] = [];

interface Letter {
  id: string;
  from: string;
  text: string;
  assignment?: {
    planId: string;
    rev: number;
    item: number | null;
    kind: string;
    current: boolean;
  };
}
interface Inbox {
  messages: Letter[];
  openAssignments?: number;
  hint?: string;
}
interface Saved {
  saved: { role: string; submission: number | null; at: string };
  next: { total: number; assignments: { item: number; action: string }[] };
}

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "parley-room-assignments-")),
  );
  project = path.join(root, "project");
  await mkdir(project);
  await mkdir(path.join(root, "home"));
  previousHome = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, "home");
  const created = await createWork(project, { title: "Room assignments" });
  workId = created.work.id;
  await updateMap(project, workId, (map) => {
    for (const label of SESSIONS)
      addSession(map, { provider: "codex", label, task: "Acceptance fixture" });
    addRoom(map, {
      title: "Delivery",
      creator: HUMAN,
      members: MEMBERS,
      lead: "s-01",
      mode: "verified",
    });
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  if (previousHome === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const mapNow = (): Promise<WorkMap> => readMap(project, workId);
async function connect(sessionId: string): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    channel: false,
  });
  const client = new Client({ name: "acceptance", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  clients.push(client);
  return client;
}
async function run(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ failed: boolean; text: string }> {
  const result = await (
    await connect(sessionId)
  ).callTool({ name, arguments: args });
  return {
    failed: result.isError === true,
    text: (result.content as { text: string }[])[0]!.text,
  };
}
/** Инструмент должен сработать: ответ — JSON. */
async function tool<T = Record<string, unknown>>(
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await run(sessionId, name, args);
  expect(result.failed, `${name}: ${result.text}`).toBe(false);
  return JSON.parse(result.text) as T;
}
const identity = (item: number, rev = 0) => ({ planId: PLAN, rev, item });
const tasks = (sessionId: string): Promise<PlanTasksView> =>
  tool<PlanTasksView>(sessionId, "plan_tasks");
const rows = (view: PlanTasksView): string[] =>
  view.assignments.map(
    (entry) => `${entry.item ?? "-"}:${entry.role}:${entry.action}`,
  );
const itemOf = (map: WorkMap, id: number): PlanItem =>
  map.plans![0]!.items.find((row) => row.id === id)!;
/** Письма Parley адресату (поручения плана). */
const parleyLetters = (to: string) =>
  readLetters(project, workId, { from: "parley", limit: 1000 }).filter((row) =>
    row.to.includes(to),
  );
const allLetters = () => readLetters(project, workId, { limit: 1000 });

const planItem = (id: number, title: string, after: number[] = []) => ({
  id,
  title,
  owner: "s-02",
  scope: `src/${id}.ts`,
  after,
  criteria: ["Works"],
  verifier: "s-03",
});
const FIRST_PLAN: PlanDraft = {
  mode: "verified",
  goal: "Ship room assignments",
  items: [
    planItem(1, "Implement"),
    planItem(2, "Integrate", [1]),
    planItem(3, "Document", [2]),
    planItem(4, "Clean up", [3]),
  ],
};

/**
 * Ведущий приносит решение, человек его принимает. Письма комнаты читаем за всех участников: проверяются
 * письма-поручения Parley, а они резервируются после этого, как у хоста сразу после принятия.
 */
async function propose(plan: PlanDraft): Promise<void> {
  await tool("s-01", "propose_decision", {
    room: "r-01",
    text: "Plan for the human",
    plan,
  });
}
async function accept(): Promise<void> {
  await updateMap(project, workId, (map, letters) => {
    const proposal = map.rooms[0]!.proposal!;
    resolveProposal(map, letters, "r-01", proposal.id, "accept", {
      rev: proposal.rev,
      planId: proposal.plan!.id,
      planRev: proposal.plan!.rev,
    });
    const at = new Date().toISOString();
    const ids = letters
      .query({ limit: 1000 })
      .filter((message) => message.from !== "parley")
      .map((message) => message.id);
    for (const id of MEMBERS) letters.markRead(id, ids, at);
    reservePlanEffects(map, letters, DEFAULT_CONFIG.messageRate);
  });
}
/** Пункт от начала до подтверждения: владелец начинает и сдаёт, проверяющий подтверждает. */
async function finish(item: number): Promise<void> {
  await tool("s-02", "plan_update", { ...identity(item), status: "in_progress" });
  await tool("s-02", "plan_submit", {
    ...identity(item),
    evidence: { text: `Item ${item} measured`, artifacts: [`src/${item}.ts`] },
  });
  await tool("s-03", "plan_verify", {
    ...identity(item),
    verdict: "verified",
    note: "Independent pass",
  });
}

describe("задания комнаты: сквозной сценарий ядра", () => {
  it("принятие → поручение → прочтение без действия → позиция → возобновление → сдача → возврат → повторная сдача → подтверждение", async () => {
    // 1. План принят: владельцу ушло одно поручение `ready`, до прочтения оно непрочитанное.
    await propose(FIRST_PLAN);
    await accept();
    let map = await mapNow();
    expect(map.plans![0]).toMatchObject({ id: PLAN, rev: 0, status: "active" });
    const ready = map.planEffects!.filter((row) => row.kind === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ target: "s-02", item: 1, status: "sent" });
    const readyLetter = allLetters().find(
      (row) => row.id === ready[0]!.messageId,
    )!;
    expect(readyLetter).toMatchObject({
      from: "parley",
      to: ["s-02"],
      kind: "note",
    });
    expect(readyLetter.text).toContain(
      "Accepted plan pl-01, revision 0, item 1: Implement",
    );
    expect(readyLetter.readBy["s-02"]).toBeUndefined();
    // Задания видны и без почты: пункт 1 — начать, остальные ждут зависимостей; проверяющий ждёт сдачи.
    expect(rows(await tasks("s-02"))).toEqual([
      "1:owner:start",
      "2:owner:wait",
      "3:owner:wait",
      "4:owner:wait",
    ]);
    expect(rows(await tasks("s-03"))).toEqual([
      "1:verifier:wait",
      "2:verifier:wait",
      "3:verifier:wait",
      "4:verifier:wait",
    ]);
    expect((await tasks("s-01")).total).toBe(0);

    // 2. Владелец читает почту: письмо помечено `assignment`, ответ напоминает об открытых заданиях.
    const inbox = await tool<Inbox>("s-02", "check_inbox");
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]!.assignment).toEqual({
      planId: PLAN,
      rev: 0,
      item: 1,
      kind: "ready",
      current: true,
    });
    expect(inbox.openAssignments).toBe(4);
    expect(inbox.hint).toBe(HINT);
    // Прочтение задания не закрывает: письма больше нет, а открытые задания остались.
    const again = await tool<Inbox>("s-02", "check_inbox");
    expect(again.messages).toEqual([]);
    expect(again.openAssignments).toBe(4);
    expect(again.hint).toBe(HINT);

    // 3. Владелец начинает и сохраняет позицию: письма и поручения не множатся, а `verified` не растёт.
    await tool("s-02", "plan_update", { ...identity(1), status: "in_progress" });
    const lettersBefore = allLetters().length;
    const progress = await tool<Saved>("s-02", "plan_progress", {
      ...identity(1),
      done: "Parser written",
      next: "Wire the CLI",
      artifacts: ["src/1.ts"],
    });
    expect(progress.saved).toMatchObject({ role: "owner", submission: null });
    expect(progress.next.assignments[0]).toMatchObject({
      item: 1,
      action: "continue",
    });
    map = await mapNow();
    expect(allLetters()).toHaveLength(lettersBefore);
    expect(itemOf(map, 1).status).toBe("in_progress");
    expect(
      map.plans![0]!.items.filter((row) => row.status === "verified"),
    ).toEqual([]);
    const ownerEntry = (await tasks("s-02")).assignments.find(
      (row) => row.item === 1,
    )!;
    expect(ownerEntry).toMatchObject({
      action: "continue",
      checkpoint: { by: "s-02", done: "Parser written", next: "Wire the CLI" },
    });
    expect(ownerEntry.checkpoint).not.toHaveProperty("stale");

    // 4. Слой возобновления: после прерывания блок называет пункт и то, что делать дальше.
    const block = assignmentsBlock(map, "s-02");
    expect(block).toMatch(
      /^Open room assignments \(reading a letter does not finish them; call plan_tasks\): /,
    );
    expect(block).toContain("pl-01 rev 0 #1 continue — next: Wire the CLI");
    const layer = buildSessionLayer({ guidance: "GUIDANCE", assignments: block });
    expect(layer.text).toContain(block);
    expect(layer.text.indexOf("GUIDANCE")).toBeLessThan(
      layer.text.indexOf(block),
    );
    expect(layer.blockBytes.assignments).toBeLessThanOrEqual(
      ASSIGNMENTS_BLOCK_MAX_BYTES,
    );

    // 5. Сдача: проверяющий получает `verify`, читает почту и сохраняет свою позицию; пункт остаётся `done`.
    await tool("s-02", "plan_submit", {
      ...identity(1),
      evidence: { text: "Parser and CLI measured", artifacts: ["src/1.ts"] },
    });
    map = await mapNow();
    const firstSubmission = planSubmission(itemOf(map, 1))!;
    expect(itemOf(map, 1).status).toBe("done");
    const verifyLetters = parleyLetters("s-03");
    expect(verifyLetters).toHaveLength(1);
    const verifierInbox = await tool<Inbox>("s-03", "check_inbox");
    expect(verifierInbox.messages[0]!.assignment).toEqual({
      planId: PLAN,
      rev: 0,
      item: 1,
      kind: "verify",
      current: true,
    });
    expect(
      (await tasks("s-03")).assignments.find((row) => row.item === 1),
    ).toMatchObject({ role: "verifier", action: "verify" });
    const effectsBefore = JSON.stringify((await mapNow()).planEffects);
    const saved = await tool<Saved>("s-03", "plan_progress", {
      ...identity(1),
      done: "Read the diff",
      next: "Run the suite",
      blocker: "Suite is slow",
    });
    expect(saved.saved).toMatchObject({
      role: "verifier",
      submission: firstSubmission,
    });
    map = await mapNow();
    // Отметка «проверяю» не подтверждает, не шлёт писем и не создаёт поручений.
    expect(itemOf(map, 1).status).toBe("done");
    expect(JSON.stringify(map.planEffects)).toBe(effectsBefore);
    expect(parleyLetters("s-03")).toHaveLength(1);
    expect(
      map.plans![0]!.items.filter((row) => row.status === "verified"),
    ).toEqual([]);
    const marked = (await tasks("s-03")).assignments.find(
      (row) => row.item === 1,
    )!;
    expect(marked.checkpoint).toMatchObject({
      by: "s-03",
      next: "Run the suite",
      blocker: "Suite is slow",
      submission: firstSubmission,
    });
    expect(marked.checkpoint).not.toHaveProperty("stale");

    // 6. Проверяющий возвращает пункт: позиция проверки снята, владельцу уходит `returned` и пункт — на доработку.
    await tool("s-03", "plan_verify", {
      ...identity(1),
      verdict: "returned",
      note: "Add a failing-input test",
    });
    map = await mapNow();
    expect(itemOf(map, 1).status).toBe("returned");
    expect(itemOf(map, 1).progress?.verifier).toBeUndefined();
    expect(itemOf(map, 1).progress?.owner).toMatchObject({ by: "s-02" });
    const returnedInbox = await tool<Inbox>("s-02", "check_inbox");
    expect(returnedInbox.messages[0]!.assignment).toEqual({
      planId: PLAN,
      rev: 0,
      item: 1,
      kind: "returned",
      current: true,
    });
    expect(
      (await tasks("s-02")).assignments.find((row) => row.item === 1),
    ).toMatchObject({ action: "rework" });
    expect(
      (await tasks("s-03")).assignments.find((row) => row.item === 1),
    ).toMatchObject({
      action: "wait",
      waitingFor: { kind: "submission", by: "s-02" },
      checkpoint: null,
    });

    // 7. Повторная сдача: номер сдачи вырос, проверяющему уходит новое `verify`, старое отменено. Прежней позиции
    // проверяющего нет: вердикт её снял (`verifyPlanItem`), поэтому устаревшей она не показывается, а просто отсутствует.
    await tool("s-02", "plan_submit", {
      ...identity(1),
      evidence: { text: "Failing input covered", artifacts: ["src/1.ts"] },
    });
    map = await mapNow();
    const secondSubmission = planSubmission(itemOf(map, 1))!;
    expect(secondSubmission).toBeGreaterThan(firstSubmission);
    const verifies = map.planEffects!.filter((row) => row.kind === "verify");
    expect(verifies.map((row) => row.status)).toEqual(["cancelled", "sent"]);
    const resubmitted = await tool<Inbox>("s-03", "check_inbox");
    expect(resubmitted.messages).toHaveLength(1);
    expect(resubmitted.messages[0]!.assignment).toMatchObject({
      kind: "verify",
      item: 1,
      current: true,
    });
    expect(
      (await tasks("s-03")).assignments.find((row) => row.item === 1),
    ).toMatchObject({
      action: "verify",
      submission: secondSubmission,
      checkpoint: null,
    });

    // 8. Подтверждение: пункт сделан, следующий открыт владельцу, а сделанный ушёл в `finished`.
    await tool("s-03", "plan_verify", {
      ...identity(1),
      verdict: "verified",
      note: "Independent pass",
    });
    map = await mapNow();
    expect(itemOf(map, 1).status).toBe("verified");
    expect(itemOf(map, 2).status).toBe("ready");
    const afterVerified = await tasks("s-02");
    expect(rows(afterVerified)).toEqual([
      "2:owner:start",
      "3:owner:wait",
      "4:owner:wait",
    ]);
    expect(afterVerified.finished.count).toBe(1);
    expect(afterVerified.finished.items[0]).toMatchObject({
      planId: PLAN,
      item: 1,
      role: "owner",
    });

    // 9. Пункт 2 до конца — он будет «сделанным, но сбрасываемым» поправкой.
    await finish(2);
    map = await mapNow();
    expect(itemOf(map, 2).status).toBe("verified");
    expect(itemOf(map, 3).status).toBe("ready");

    // 10. Поправка: меняется пункт 2 (сделанный), пункт 4 убирается, пункт 5 добавляется. Карточка решения —
    // `planRemaining`: сделанный неизменённый пункт 1 скрыт, пункты 2 (redo), 3 (changed) и 5 (new) показаны.
    await propose({
      mode: "verified",
      goal: FIRST_PLAN.goal,
      id: PLAN,
      rev: 0,
      items: [
        planItem(1, "Implement"),
        { ...planItem(2, "Integrate", [1]), scope: "src/2.ts src/2-extra.ts" },
        planItem(3, "Document", [2]),
        planItem(5, "Announce", [3]),
      ],
    });
    map = await mapNow();
    const proposed = map.rooms[0]!.proposal!.plan!;
    const remaining = planRemaining(map.plans![0], proposed);
    expect(remaining.base).toEqual({ id: PLAN, rev: 0 });
    expect(
      remaining.items.map((row) => [row.item.id, row.status, row.mark]),
    ).toEqual([
      [2, "ready", "redo"],
      [3, "waiting", "changed"],
      [5, "waiting", "new"],
    ]);
    expect(remaining.doneHidden).toBe(1);
    expect(remaining.removed).toEqual([{ id: 4, title: "Clean up" }]);
    // Пока решение не принято, задания живут по старой ревизии.
    expect(rows(await tasks("s-02"))).toEqual([
      "3:owner:start",
      "4:owner:wait",
    ]);

    // 11. Принятие: оставшееся совпадает с обещанным карточкой, а следующий доступный пункт — первое задание.
    await accept();
    map = await mapNow();
    expect(map.plans![0]!.rev).toBe(1);
    expect(
      map.plans![0]!.items
        .filter((row) => !planItemSatisfied(map.plans![0]!, row))
        .map((row) => [row.id, row.status]),
    ).toEqual(remaining.items.map((row) => [row.item.id, row.status]));
    expect(itemOf(map, 1).status).toBe("verified");
    expect(map.plans![0]!.items.map((row) => row.id)).toEqual([1, 2, 3, 5]);
    const afterAmendment = await tasks("s-02");
    expect(rows(afterAmendment)).toEqual([
      "2:owner:start",
      "3:owner:wait",
      "5:owner:wait",
    ]);
    expect(afterAmendment.assignments[0]).toMatchObject({ planId: PLAN, rev: 1 });
    expect(afterAmendment.finished.count).toBe(1);
    const amended = await tool<Inbox>("s-02", "check_inbox");
    expect(
      amended.messages.map((row) => row.assignment).filter(Boolean),
    ).toEqual([
      { planId: PLAN, rev: 1, item: 2, kind: "ready", current: true },
    ]);
  }, 120_000);

  it("позиция проверяющего, сохранённая для более ранней сдачи, в plan_tasks помечена stale", async () => {
    await propose(FIRST_PLAN);
    await accept();
    await tool("s-02", "plan_update", { ...identity(1), status: "in_progress" });
    await tool("s-02", "plan_submit", {
      ...identity(1),
      evidence: { text: "Measured", artifacts: [] },
    });
    await tool("s-03", "plan_progress", {
      ...identity(1),
      done: "Read the diff",
      next: "Run the suite",
    });
    expect(
      (await tasks("s-03")).assignments.find((row) => row.item === 1)!
        .checkpoint,
    ).not.toHaveProperty("stale");
    // Настоящие мутации прежнюю позицию проверяющего снимают (вердикт, сброс, смена режима), поэтому устаревшей она
    // бывает только как защитный случай: повторная сдача записана в журнал, а позиция осталась. Берём его напрямую.
    await updateMap(project, workId, (map) => {
      itemOf(map, 1).log.push({
        at: new Date().toISOString(),
        by: "s-02",
        status: "done",
        note: null,
      });
    });
    expect(
      (await tasks("s-03")).assignments.find((row) => row.item === 1)!
        .checkpoint,
    ).toMatchObject({ by: "s-03", stale: true });
  }, 60_000);

  it("одиночный чат без комнаты не получает ни записей plan_tasks, ни блока заданий, ни напоминаний", async () => {
    await propose(FIRST_PLAN);
    await accept();
    const map = await mapNow();
    // Участники получают задания; одиночный чат s-04 — нет.
    expect((await tasks("s-02")).total).toBeGreaterThan(0);
    const solo = await tasks("s-04");
    expect(solo.total).toBe(0);
    expect(solo.assignments).toEqual([]);
    expect(solo.finished.count).toBe(0);
    expect(planTasksView(map, "s-04", {}).total).toBe(0);
    // Блока заданий в слое нет, а у участника он есть.
    expect(assignmentsBlock(map, "s-04")).toBe("");
    expect(
      buildSessionLayer({
        guidance: "GUIDANCE",
        assignments: assignmentsBlock(map, "s-04"),
      }).text,
    ).not.toContain("Open room assignments");
    expect(assignmentsBlock(map, "s-02")).toContain("Open room assignments");
    // Почта чата без заданий прежней формы: ни `openAssignments`, ни подсказки.
    const inbox = await tool<Inbox>("s-04", "check_inbox");
    expect(inbox).not.toHaveProperty("openAssignments");
    expect(inbox).not.toHaveProperty("hint");
    // Чужой план не читается и не меняется.
    const before = JSON.stringify(await mapNow());
    expect(
      (await run("s-04", "plan_tasks", { planId: PLAN, item: 1 })).failed,
    ).toBe(true);
    for (const [name, args] of [
      ["plan_update", { ...identity(1), status: "in_progress" }],
      [
        "plan_progress",
        { ...identity(1), done: "Nothing", next: "Nothing" },
      ],
    ] as const)
      expect((await run("s-04", name, args)).failed, name).toBe(true);
    expect(JSON.stringify(await mapNow())).toBe(before);
  }, 60_000);
});
