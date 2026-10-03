import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import {
  prepareSharedIgnore,
  readMap,
  readSharedFile,
  sharedProjectPaths,
  updateMap,
  withSharedProjectLock,
  MISSING_SHARED_VERSION,
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

/** Exclusive publication of a fully written file: existing versions are compared, never replaced.
 * Directory checks bound redirects; portable check/link/unlink is not adversarial filesystem CAS.
 */
async function publishSnapshot(
  dir: string,
  parent: string,
  intent: PlanExportIntent,
  options: SharedWriteOptions,
): Promise<void> {
  if (!valid(intent)) throw new PlanSnapshotError("snapshot-invalid");
  const root = await lstat(dir);
  if (!root.isDirectory() || (await realpath(dir)) !== dir)
    throw new PlanSnapshotError("snapshot-write-failed");
  try {
    await mkdir(parent, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const parentHandle = await open(
    parent,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const temporary = path.join(dir, `.plan-${randomUUID()}.tmp`);
  let ownedTemporary: { ino: number; dev: number } | undefined;
  const temporaryIsOwned = async (): Promise<boolean> => {
    if (!ownedTemporary) return false;
    try {
      const current = await lstat(temporary);
      return (
        current.isFile() &&
        current.ino === ownedTemporary.ino &&
        current.dev === ownedTemporary.dev &&
        (await readSharedFile(temporary)).text === intent.content
      );
    } catch {
      return false;
    }
  };
  try {
    const identity = await parentHandle.stat();
    const verify = async (): Promise<void> => {
      const current = await lstat(parent);
      const currentRoot = await lstat(dir);
      if (
        !identity.isDirectory() ||
        !current.isDirectory() ||
        identity.ino !== current.ino ||
        identity.dev !== current.dev ||
        !currentRoot.isDirectory() ||
        root.ino !== currentRoot.ino ||
        root.dev !== currentRoot.dev ||
        (await realpath(parent)) !== parent
      )
        throw new PlanSnapshotError("snapshot-write-failed");
    };
    await verify();
    const file = path.join(parent, intent.file);
    const previous = await readSharedFile(file);
    if (previous.version !== MISSING_SHARED_VERSION) {
      if (previous.text !== intent.content)
        throw new PlanSnapshotError("snapshot-conflict");
      return;
    }
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    try {
      ownedTemporary = await handle.stat();
      await handle.writeFile(intent.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeCommit?.(file, 0);
    await verify();
    if (!(await temporaryIsOwned()))
      throw new PlanSnapshotError("snapshot-write-failed");
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readSharedFile(file)).text !== intent.content)
        throw new PlanSnapshotError("snapshot-conflict");
    }
    await verify();
    if ((await readSharedFile(file)).text !== intent.content)
      throw new PlanSnapshotError("snapshot-conflict");
  } finally {
    try {
      const current = await lstat(dir);
      if (
        current.isDirectory() &&
        root.ino === current.ino &&
        root.dev === current.dev &&
        (await realpath(dir)) === dir &&
        (await temporaryIsOwned())
      )
        await unlink(temporary).catch(() => undefined);
    } finally {
      await parentHandle.close();
    }
  }
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
  options: SharedWriteOptions = {},
): Promise<PlanSnapshotFlushResult> {
  const map = await readMap(projectPath, workId);
  const result: PlanSnapshotFlushResult = {
    written: [],
    failed: [],
    diagnostics: [],
  };
  for (const intent of map.planExports?.filter(
    (intent) => intent.status === "pending",
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
          await publishSnapshot(paths.dir, paths.plans, intent, options);
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
