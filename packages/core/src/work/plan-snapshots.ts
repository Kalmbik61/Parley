import { ImmutableMarkdownError, publishImmutableMarkdown } from "./shared-markdown.js";
import {
  prepareSharedIgnore,
  readMap,
  sharedProjectPaths,
  updateMap,
  withSharedProjectLock,
} from "./store.js";
import type { SharedDiagnostic, SharedWriteOptions } from "./store.js";
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
  typeof intent.content === "string" &&
  Buffer.byteLength(intent.content) <= 1024 * 1024 &&
  Buffer.from(intent.content, "utf8").toString("utf8") === intent.content;
const metadata = (value: string): string =>
  JSON.stringify(
    value.length <= 512
      ? value
      : `${value.slice(0, 512)}… [metadata truncated]`,
  );
export function capturePlanSnapshot(
  map: WorkMap,
  plan: RoomPlan,
  event: PlanExportIntent["event"],
  removedItems: readonly PlanItem[] = [],
): PlanExportIntent {
  const file = `${map.work.id}-${plan.roomId}-${plan.id}-rev-${plan.rev}-${event}.md`;
  const lines = [
    `# Plan ${plan.id} — revision ${plan.rev} (${event})`,
    "",
    `Work: ${map.work.id}; room: ${plan.roomId}`,
    `Mode: ${plan.mode}; status: ${plan.status}`,
    `Accepted: ${plan.acceptedAt ?? "—"}; completed: ${plan.completedAt ?? "—"}; cancelled: ${plan.cancelledAt ?? "—"}`,
    "",
    "## Goal",
    plan.goal,
    "",
    "## Items",
  ];
  for (const [heading, items] of [
    ["Items", plan.items],
    ["Removed items at this amendment", removedItems],
  ] as const) {
    if (heading !== "Items" && items.length) lines.push("", `## ${heading}`);
    for (const item of items) {
      const owner = map.sessions.find((session) => session.id === item.owner);
      const role = owner?.role
        ? `${owner.role.source}:${owner.role.name}`
        : "—";
      lines.push(
        "",
        `### ${item.id}. ${item.title}`,
        `Owner: ${item.owner}; label: ${metadata(owner?.label ?? "[deleted]")}; role: ${metadata(role)}`,
        `Status: ${item.status}; after: ${item.after.join(", ") || "—"}; verifier: ${item.verifier ?? "—"}`,
        "",
        "Scope:",
        item.scope,
      );
      if (item.acceptedChecklistRevision !== undefined)
        lines.push(
          "",
          `Completion basis: accepted Checklist revision ${item.acceptedChecklistRevision}; no verification claimed.`,
        );
      if (item.criteria.length)
        lines.push(
          "",
          "Criteria:",
          ...item.criteria.map((value) => `- ${value}`),
        );
      if (item.evidence)
        lines.push(
          "",
          "Evidence:",
          item.evidence.text,
          ...item.evidence.artifacts.map((value) => `- ${value}`),
        );
      if (item.note) lines.push("", "Note:", item.note);
    }
  }
  if (plan.backlog.length)
    lines.push("", `Backlog: ${plan.backlog.join(", ")}`);
  if (plan.completionSummary)
    lines.push("", "## Completion", plan.completionSummary);
  const intent: PlanExportIntent = {
    file,
    planId: plan.id,
    rev: plan.rev,
    event,
    content: `${lines.join("\n")}\n`,
    status: "pending",
  };
  if (!valid(intent)) throw new PlanSnapshotError("snapshot-invalid");
  map.planExports ??= [];
  const previous = map.planExports.find((entry) => entry.file === file);
  if (previous) {
    if (previous.content !== intent.content)
      throw new PlanSnapshotError("snapshot-conflict");
    return previous;
  }
  map.planExports.push(intent);
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
          try { await publishImmutableMarkdown(paths.dir, paths.plans, intent, options); }
          catch (error) {
            if (error instanceof ImmutableMarkdownError) throw new PlanSnapshotError(
              error.code === "conflict" ? "snapshot-conflict" : error.code === "invalid" ? "snapshot-invalid" : "snapshot-write-failed",
            );
            throw error;
          }
        },
        options,
      );
      await updateMap(
        projectPath,
        workId,
        (current) => {
          const captured = current.planExports?.find(
            (candidate) =>
              candidate.file === intent.file &&
              candidate.content === intent.content,
          );
          if (captured) captured.status = "written";
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
