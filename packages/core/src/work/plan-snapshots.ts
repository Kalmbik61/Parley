import { createTranslator, type AppLocale } from '../i18n/index.js';
import { planExportCatalog } from '../i18n/export-catalog.js';
import { exportLocale } from './export-locale.js';
import { ImmutableMarkdownError, publishImmutableMarkdown } from "./shared-markdown.js";
import {
  prepareSharedIgnore,
  readMap,
  sharedProjectPaths,
  updateMap,
  withSharedProjectLock,
} from "./store.js";
import type { SharedDiagnostic, SharedWriteOptions } from "./store.js";
import { exportSha256, hasDigestOnly, settleExport, sha256Hex } from "./stored-texts.js";
import type { PlanExportIntent, PlanItem, RoomPlan, WorkMap } from "./types.js";

export class PlanSnapshotError extends Error {
  constructor(
    readonly code:
      "snapshot-conflict" | "snapshot-invalid" | "snapshot-write-failed",
  ) {
    super(code);
    this.name = "PlanSnapshotError";
  }
}
const valid = (intent: PlanExportIntent): boolean =>
  /^w-\d+-r-\d+-pl-\d+-rev-\d+-(accepted|completed|cancelled)\.md$/.test(
    intent.file,
  ) &&
  intent.file.endsWith(
    `-${intent.planId}-rev-${intent.rev}-${intent.event}.md`,
  ) &&
  Number.isSafeInteger(intent.rev) &&
  intent.rev >= 0 &&
  (hasDigestOnly(intent) ||
    (typeof intent.content === "string" &&
      Buffer.byteLength(intent.content) <= 1024 * 1024 &&
      Buffer.from(intent.content, "utf8").toString("utf8") === intent.content));
function renderPlanSnapshot(
  map: WorkMap,
  plan: RoomPlan,
  event: PlanExportIntent["event"],
  removedItems: readonly PlanItem[],
  locale: AppLocale,
): string {
  const t = createTranslator(locale, planExportCatalog);
  const metadata = (value: string): string =>
    JSON.stringify(value.length <= 512 ? value : t('metadataTruncated', { prefix: value.slice(0, 512) }));
  const lines = [
    `# ${t('title', { id: plan.id, rev: plan.rev, event })}`,
    "",
    t('workspace', { workId: map.work.id, roomId: plan.roomId }),
    t('status', { mode: plan.mode, status: plan.status }),
    t('dates', { accepted: plan.acceptedAt ?? "—", completed: plan.completedAt ?? "—", cancelled: plan.cancelledAt ?? "—" }),
    "",
    `## ${t('goal')}`,
    plan.goal,
    "",
    `## ${t('items')}`,
  ];
  for (const [removed, items] of [[false, plan.items], [true, removedItems]] as const) {
    if (removed && items.length) lines.push("", `## ${t('removed')}`);
    for (const item of items) {
      const owner = map.sessions.find((session) => session.id === item.owner);
      const role = owner?.role ? `${owner.role.source}:${owner.role.name}` : "—";
      lines.push(
        "",
        `### ${item.id}. ${item.title}`,
        t('owner', { owner: item.owner, label: metadata(owner?.label ?? t('deleted')), role: metadata(role) }),
        t('itemStatus', { status: item.status, after: item.after.join(", ") || "—", verifier: item.verifier ?? "—" }),
        "",
        t('scope'),
        item.scope,
      );
      if (item.acceptedChecklistRevision !== undefined)
        lines.push("", t('acceptedChecklist', { rev: item.acceptedChecklistRevision }));
      if (item.criteria.length)
        lines.push("", t('criteria'), ...item.criteria.map((value) => `- ${value}`));
      if (item.evidence)
        lines.push("", t('evidence'), item.evidence.text, ...item.evidence.artifacts.map((value) => `- ${value}`));
      if (item.note) lines.push("", t('note'), item.note);
    }
  }
  if (plan.backlog.length)
    lines.push("", t('backlog', { ids: plan.backlog.join(", ") }));
  if (plan.completionSummary)
    lines.push("", `## ${t('completion')}`, plan.completionSummary);
  return `${lines.join("\n")}\n`;
}

export function capturePlanSnapshot(
  map: WorkMap,
  plan: RoomPlan,
  event: PlanExportIntent["event"],
  removedItems: readonly PlanItem[] = [],
  locale = exportLocale(),
): PlanExportIntent {
  const file = `${map.work.id}-${plan.roomId}-${plan.id}-rev-${plan.rev}-${event}.md`;
  const content = renderPlanSnapshot(map, plan, event, removedItems, locale);
  const intent: PlanExportIntent = {
    file,
    planId: plan.id,
    rev: plan.rev,
    event,
    content,
    status: "pending",
  };
  const previous = map.planExports?.find((entry) => entry.file === file);
  if (previous) {
    const digest = exportSha256(previous);
    // Повтор с другой настройкой языка сохраняет ранее захваченный текст или хеш.
    if (digest !== sha256Hex(content)) {
      const priorLocale = locale === 'en' ? 'ru' : 'en';
      if (digest !== sha256Hex(renderPlanSnapshot(map, plan, event, removedItems, priorLocale)))
        throw new PlanSnapshotError("snapshot-conflict");
    }
    return previous;
  }
  if (!valid(intent)) throw new PlanSnapshotError("snapshot-invalid");
  (map.planExports ??= []).push(intent);
  return intent;
}

export interface PlanSnapshotFlushResult {
  written: string[];
  failed: { file: string; code: PlanSnapshotError["code"] }[];
  diagnostics: SharedDiagnostic[];
}
/** Invoke after updateMap returns. No map lock is ever held together with the shared-domain lock.
 * A write/ack failure leaves the captured intent pending; retry compares the exact original content.
 */
export async function flushPlanSnapshots(
  projectPath: string,
  workId: string,
  options: SharedWriteOptions & { excludedFiles?: ReadonlySet<string> } = {},
): Promise<PlanSnapshotFlushResult> {
  const map = await readMap(projectPath, workId);
  const result: PlanSnapshotFlushResult = {
    written: [],
    failed: [],
    diagnostics: [],
  };
  for (const intent of map.planExports?.filter(
    (intent) => intent.status === "pending" && !options.excludedFiles?.has(intent.file),
  ) ?? []) {
    try {
      // Ожидающий экспорт всегда с текстом: по нему файл пишется и повторяется (спека хранилища 6.2).
      const content = intent.content;
      if (content === undefined) throw new PlanSnapshotError("snapshot-invalid");
      const paths = await sharedProjectPaths(projectPath, options);
      if (!intent.file.startsWith(`${workId}-`))
        throw new PlanSnapshotError("snapshot-invalid");
      await withSharedProjectLock(
        paths,
        async () => {
          result.diagnostics.push(
            ...(await prepareSharedIgnore(paths, options)),
          );
          if (!valid(intent)) throw new PlanSnapshotError("snapshot-invalid");
          try { await publishImmutableMarkdown(paths.dir, paths.plans, { file: intent.file, content }, options); }
          catch (error) {
            if (error instanceof ImmutableMarkdownError) throw new PlanSnapshotError(
              error.code === "conflict" ? "snapshot-conflict" : error.code === "invalid" ? "snapshot-invalid" : "snapshot-write-failed",
            );
            throw error;
          }
        },
        options,
      );
      // Запись подтверждается по (файл, sha256 текста) и тут же убирает текст из карты (спека хранилища 6.2).
      const sha256 = sha256Hex(content);
      await updateMap(
        projectPath,
        workId,
        (current) => {
          const captured = current.planExports?.find(
            (candidate) =>
              candidate.file === intent.file &&
              exportSha256(candidate) === sha256,
          );
          if (captured) settleExport(captured);
        },
        { ...options, touch: false },
      );
      result.written.push(intent.file);
    } catch (error) {
      result.failed.push({
        file: intent.file,
        code:
          error instanceof PlanSnapshotError
            ? error.code
            : "snapshot-write-failed",
      });
    }
  }
  result.diagnostics = [
    ...new Map(result.diagnostics.map((value) => [value.code, value])).values(),
  ];
  return result;
}
