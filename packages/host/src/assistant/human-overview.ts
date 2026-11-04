import { liveLead, sessionDotStateWithNeed, type WorkEntry, type WorkSession } from '@parley/core';
import { sessionNeed } from '@parley/core/attention';
import { normalizeHumanText } from '@parley/core/assistant';
import type {
  HumanOverviewGroup,
  HumanOverviewMember,
  HumanOverviewRoom,
  HumanOverviewSession,
  HumanOverviewV1,
  HumanOverviewWait,
} from '@parley/protocol';
import { targetsOf, type OverviewSource } from './overview.js';

export interface HumanOverviewOptions {
  /** The caller supplies catalogue coverage; entries already contain only permitted scope. */
  mapComplete?: boolean;
  detailed?: boolean;
}
const groups: HumanOverviewGroup[] = ['needsHuman', 'working', 'other'];
const archived = (room: { archivedAt?: unknown }): boolean => typeof room.archivedAt === 'string';
const groupOf = (
  members: readonly HumanOverviewMember[],
  waits: readonly HumanOverviewWait[],
): HumanOverviewGroup =>
  waits.some((wait) => wait.needsHuman)
    ? 'needsHuman'
    : members.some((member) => member.state === 'working')
      ? 'working'
      : 'other';

/** Pure projection. Async card collection belongs to the caller; never infer activity from a plan. */
export function humanOverview(
  source: OverviewSource,
  options: HumanOverviewOptions = {},
): HumanOverviewV1 {
  const targets = targetsOf(source, { hidden: true });
  const refs: Record<string, string> = {};
  const reasons = new Set<string>();
  let activityAvailable = true;
  let cardsAvailable = true;
  const targetRef = (entry: WorkEntry, kind: 'work' | 'room' | 'session', id: string): string => {
    const target = targets.find(
      (target) =>
        target.kind === kind &&
        (target.kind === 'session'
          ? target.ref.projectPath === entry.projectPath &&
            target.ref.workId === entry.map.work.id &&
            target.ref.sessionId === id
          : target.projectPath === entry.projectPath &&
            target.workId === entry.map.work.id &&
            (target.kind === 'work' || target.roomId === id)),
    );
    if (!target) throw new Error('Overview target disappeared before projection');
    return target.id;
  };
  // Raw ids are work-local. Ambiguous aliases are deliberately left to the neutral normalizer fallback.
  const aliases = new Map<string, Set<string>>();
  const alias = (key: string, name: string): void => {
    const names = aliases.get(key) ?? new Set<string>();
    names.add(name);
    aliases.set(key, names);
  };
  const names = new Map<string, string>();
  for (const entry of source.entries.filter((entry) => entry.map.work.status !== 'archived')) {
    alias(entry.map.work.id, normalizeHumanText(entry.map.work.title, {}));
    for (const room of entry.map.rooms.filter((room) => !archived(room)))
      alias(room.id, normalizeHumanText(room.title, {}));
    for (const session of entry.map.sessions) {
      const room = entry.map.rooms.find(
        (room) => !archived(room) && room.members.includes(session.id),
      );
      const fallback = `${session.role?.name ?? 'участник'}${room ? ` комнаты ${normalizeHumanText(room.title, {})}` : ''}`;
      // A generated prefix is naming metadata; arbitrary prose is handled only by O1.
      const generated = session.label.trim().match(/^(?:S\d+|s-\d+)(?:\s+(.+))?$/);
      const label = normalizeHumanText(generated ? (generated[1] ?? '') : session.label, {});
      const base = label || normalizeHumanText(fallback, {});
      const duplicates =
        entry.map.sessions.filter((other) => other.label.trim() === session.label.trim()).length >
        1;
      const name = duplicates
        ? `${base}, ${normalizeHumanText(session.role?.name ?? 'участник', {})}${room ? `, ${normalizeHumanText(room.title, {})}` : ''}, ${normalizeHumanText(entry.map.work.title, {})}`
        : base;
      const ref = targetRef(entry, 'session', session.id);
      names.set(ref, name);
      alias(session.id, name);
      alias(`@s${session.id.replace(/^s-0*/, '')}`, name);
      for (const tag of session.label.match(/\bS\d+\b/g) ?? []) alias(tag, name);
      refs[ref] = name;
    }
    for (const target of targets.filter(
      (target) =>
        target.kind !== 'session' &&
        target.projectPath === entry.projectPath &&
        target.workId === entry.map.work.id &&
        !target.hidden,
    ))
      refs[target.id] = normalizeHumanText(target.name, {});
  }
  for (const [key, values] of aliases) if (values.size === 1) refs[key] = [...values][0]!;
  const human = (text: string): string => normalizeHumanText(text, refs);
  const readSession = (entry: WorkEntry, session: WorkSession): HumanOverviewSession => {
    const ref = targetRef(entry, 'session', session.id);
    const sessionRef = {
      projectPath: entry.projectPath,
      workId: entry.map.work.id,
      sessionId: session.id,
    };
    const cards = source.cards?.(sessionRef);
    const live = source.live(sessionRef);
    const known = session.lifecycle !== 'active' || live !== undefined;
    if (!known) {
      activityAvailable = false;
      reasons.add('Текущая активность части участников недоступна.');
    }
    if (session.lifecycle === 'active' && cards === undefined) {
      cardsAvailable = false;
      reasons.add('Карточки ожиданий части участников недоступны.');
    }
    const need = sessionNeed(session, live?.activity ?? null);
    const state = known
      ? sessionDotStateWithNeed(session, live?.activity.activity ?? null, need)
      : 'unknown';
    const displayName = names.get(ref)!;
    const waits: HumanOverviewWait[] = [];
    if (need)
      waits.push({
        text: human(
          `${displayName}: ${need.kind === 'limit' ? 'ждёт сброса лимита' : `ждёт действия человека (${need.kind})`}${need.detail ? `: ${need.detail}` : ''}${need.resetsAt ? `, сброс ${need.resetsAt}` : ''}`,
        ),
        needsHuman: need.kind !== 'limit',
        actorRef: ref,
        source: { kind: 'activity', ref, at: need.since },
      });
    if (session.lifecycle === 'active')
      for (const card of cards ?? []) {
        if (card.state !== 'pending') continue;
        waits.push({
          text: human(
            `${displayName}: ${card.kind === 'question' ? card.questions.map((question) => question.question).join('; ') : card.kind === 'plan' ? 'ждёт одобрения плана' : 'ждёт разрешения'}`,
          ),
          needsHuman: true,
          actorRef: ref,
          source: { kind: 'card', ref: card.cardId, at: card.at },
        });
      }
    if (session.queued && session.lifecycle !== 'active' && session.lifecycle !== 'closed')
      waits.push({
        text: `${displayName}: ждёт запуска`,
        needsHuman: false,
        actorRef: ref,
        source: { kind: 'activity', ref, at: null },
      });
    if (live?.activity.waitingFor && session.lifecycle === 'active')
      waits.push({
        text: human(
          `${displayName}: ждёт ${live.activity.waitingFor === 'inbox' ? 'почту' : live.activity.waitingFor}`,
        ),
        needsHuman: false,
        actorRef: ref,
        source: { kind: 'activity', ref, at: null },
      });
    const member: HumanOverviewMember = {
      ref,
      displayName,
      role: session.role ? human(session.role.name) : null,
      lifecycle: session.lifecycle,
      state,
      activityKnown: known,
      ambiguous: [...names.values()].filter((name) => name === displayName).length > 1,
    };
    return { ...member, group: groupOf([member], waits), waits };
  };
  const rooms: HumanOverviewRoom[] = [];
  const unassignedSessions: HumanOverviewSession[] = [];
  const works: string[] = [];
  for (const entry of source.entries.filter((entry) => entry.map.work.status !== 'archived')) {
    works.push(targetRef(entry, 'work', entry.map.work.id));
    for (const room of entry.map.rooms.filter((room) => !archived(room))) {
      const ref = targetRef(entry, 'room', room.id);
      const members = room.members.map((id): HumanOverviewSession => {
        const session = entry.map.sessions.find((session) => session.id === id);
        if (session) return readSession(entry, session);
        reasons.add('Сведения о части участников недоступны.');
        activityAvailable = false;
        return {
          ref: `session:${ref.slice(5, ref.lastIndexOf(':'))}:${id}`,
          displayName: 'участник, сведения о котором недоступны',
          role: null,
          lifecycle: null,
          state: 'unknown',
          activityKnown: false,
          ambiguous: true,
          group: 'other',
          waits: [],
        };
      });
      const waits = members.flatMap((member) => member.waits);
      if (room.proposal)
        waits.unshift({
          text: human(`Человек: требуется решение — ${room.proposal.text}`),
          needsHuman: true,
          actorRef: null,
          source: {
            kind: 'proposal',
            ref: room.proposal.id,
            rev: room.proposal.rev,
            at: room.proposal.at,
          },
        });
      const plans = (entry.map.plans ?? []).filter(
        (plan) =>
          plan.roomId === room.id &&
          plan.acceptedAt !== null &&
          (plan.status === 'active' || plan.status === 'completing'),
      );
      const plan = plans.length === 1 ? plans[0] : undefined;
      const warnings: string[] = [];
      const activityKnown = members.every((member) => member.activityKnown);
      if (!activityKnown) warnings.push('Текущая активность недоступна.');
      if (members.length === 0) warnings.push('Текущая активность комнаты не подтверждена.');
      else if (members.every((member) => member.lifecycle === 'closed'))
        warnings.push('Все участники закрыты.');
      else if (members.some((member) => member.state === 'unseen'))
        warnings.push('Есть непросмотренный результат.');
      else if (members.every((member) => member.state === 'idle'))
        warnings.push('Участники простаивают.');
      else if (members.some((member) => member.lifecycle === 'sleeping'))
        warnings.push('Часть участников спит.');
      if (members.some((member) => member.state === 'blocked') && waits.length === 0)
        warnings.push('Причина ожидания не указана.');

      if (plans.length > 1)
        warnings.push('Несколько несовместимых текущих планов; текущий шаг не определён.');
      if (members.some((member) => member.ambiguous))
        warnings.push('Имена неоднозначны; для выбора участника требуется уточнение.');
      const currentSteps = (plan?.items ?? [])
        .filter((item) => item.status !== 'verified' && item.status !== 'waiting')
        .map((item) => ({
          text: human(
            `${item.title}: ${item.status === 'in_progress' ? 'по плану выполняется' : item.status === 'done' ? (plan?.mode === 'checklist' ? 'отмечено выполненным в плане' : 'сдано на проверку') : item.status === 'blocked' ? `препятствие: ${item.note || 'причина ожидания не указана'}` : item.status === 'returned' ? 'возвращено на доработку' : 'готово к началу'}`,
          ),
          source: {
            kind: 'plan' as const,
            ref: plan!.id,
            rev: plan!.rev,
            item: item.id,
            at: item.log.at(-1)?.at ?? plan!.acceptedAt,
          },
        }));
      if (
        plan?.items.some((item) => item.status === 'in_progress') &&
        !members.some((member) => member.state === 'working')
      )
        warnings.push('В плане шаг отмечен выполняющимся; текущая активность не подтверждена.');
      const leadId = liveLead(entry.map, room);
      const lead = leadId
        ? (members.find((member) => member.ref === targetRef(entry, 'session', leadId)) ?? null)
        : null;
      const note =
        options.detailed && leadId
          ? source
              .roomTail(entry, room.id, 10)
              .filter((message) => message.from === leadId)
              .at(-1)
          : undefined;
      const projected: HumanOverviewRoom = {
        ref,
        title: human(room.title),
        workLabel: human(entry.map.work.title),
        group: groupOf(members, waits),
        activityKnown,
        task: {
          text: human(plan?.goal || room.title),
          goalKnown: Boolean(plan?.goal),
          source: plan ? { kind: 'plan', ref: plan.id, rev: plan.rev, at: plan.acceptedAt } : null,
        },
        currentSteps,
        lead,
        members,
        waits,
        warnings,
      };
      if (note)
        projected.latestLeadNote = {
          text: human(note.text),
          source: { kind: 'message', ref: note.id, at: note.at },
        };
      rooms.push(projected);
    }
    // Membership in archived rooms does not turn a participant into an unassigned session.
    for (const session of entry.map.sessions.filter(
      (session) =>
        session.lifecycle !== 'closed' &&
        !entry.map.rooms.some((room) => room.members.includes(session.id)),
    ))
      unassignedSessions.push(readSession(entry, session));
  }
  // A caller's card reader can reveal a concurrent archive/removal. Do not publish stale entities.
  const visibleRooms = rooms.filter((room) =>
    source.entries.some(
      (entry) =>
        entry.map.work.status !== 'archived' &&
        entry.map.rooms.some(
          (current) => !archived(current) && targetRef(entry, 'room', current.id) === room.ref,
        ),
    ),
  );
  if (visibleRooms.length !== rooms.length)
    reasons.add('Во время сбора комната исчезла или была архивирована; покрытие неполно.');
  const visibleSessions = unassignedSessions.filter((session) =>
    source.entries.some(
      (entry) =>
        entry.map.work.status !== 'archived' &&
        entry.map.sessions.some(
          (current) =>
            current.lifecycle !== 'closed' &&
            targetRef(entry, 'session', current.id) === session.ref,
        ),
    ),
  );
  const visibleWorks = works.filter((ref) =>
    source.entries.some(
      (entry) =>
        entry.map.work.status !== 'archived' && targetRef(entry, 'work', entry.map.work.id) === ref,
    ),
  );
  const mapComplete =
    options.mapComplete !== false &&
    visibleRooms.length === rooms.length &&
    visibleSessions.length === unassignedSessions.length &&
    visibleWorks.length === works.length;
  if (!mapComplete) reasons.add('Карта выбранной области неполна.');
  visibleRooms.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
  const overview: HumanOverviewV1 = {
    schemaVersion: 1,
    capturedAt: (source.now ?? new Date()).toISOString(),
    scope: { works: visibleWorks, rooms: visibleRooms.map((room) => room.ref) },
    coverage: { mapComplete, activityAvailable, cardsAvailable, reasons: [...reasons] },
    counts: { needsHuman: 0, working: 0, other: 0, activityUnknown: 0 },
    rooms: visibleRooms,
    unassignedSessions: visibleSessions,
    text: '',
  };
  for (const room of visibleRooms) {
    overview.counts[room.group]++;
    if (!room.activityKnown) overview.counts.activityUnknown++;
  }
  overview.text = renderHumanOverview(overview, options.detailed);
  return overview;
}

/** Both lengths render the same facts; short form explicitly counts rooms left unlisted. */
export function renderHumanOverview(overview: HumanOverviewV1, detailed = false): string {
  const labels = {
    needsHuman: 'Ждут человека',
    working: 'Работают',
    other: 'Приостановлены или без текущей работы',
  };
  const lines = [
    `Снимок на ${overview.capturedAt}. Область: ${overview.scope.works.length} работ, ${overview.rooms.length} комнат.`,
  ];
  for (const group of groups) {
    const rooms = overview.rooms.filter((room) => room.group === group);
    lines.push(`${labels[group]}: ${rooms.length}.`);
    const listed = detailed ? rooms : group === 'other' ? [] : rooms.slice(0, 3);
    for (const room of listed) {
      lines.push(
        `${room.title} (${room.workLabel}): ${room.task.text}${room.task.goalKnown ? '' : ' (цель плана не указана)'}. Ведущий: ${room.lead?.displayName ?? 'нет действующего ведущего'}.`,
      );
      lines.push(
        ...room.currentSteps.map((step) => step.text),
        ...room.waits.map((wait) => wait.text),
        ...room.warnings,
      );
      if (detailed) {
        lines.push(
          ...room.members.map(
            (member) =>
              `${member.displayName}: ${member.state === 'unknown' ? 'активность неизвестна' : member.state}.`,
          ),
        );
        if (room.latestLeadNote)
          lines.push(
            `В последнем сообщении от ${room.latestLeadNote.source.at ?? 'неизвестного времени'} ведущий сообщил: ${room.latestLeadNote.text}. Это сообщение, не подтверждение текущей работы.`,
          );
      }
    }
    if (listed.length < rooms.length)
      lines.push(
        `Не перечислено комнат: ${rooms.length - listed.length}. ${[...new Set(rooms.flatMap((room) => [...room.warnings, ...room.waits.map((wait) => wait.text)]))].join(' ')}`,
      );
  }
  lines.push(`Вне комнат незакрытых участников: ${overview.unassignedSessions.length}.`);
  for (const session of overview.unassignedSessions.filter(
    (session) => detailed || session.group !== 'other',
  ))
    lines.push(
      `${session.displayName}: ${session.state}. ${session.waits.map((wait) => wait.text).join(' ')}`,
    );
  lines.push(...overview.coverage.reasons);
  return lines.join('\n');
}
