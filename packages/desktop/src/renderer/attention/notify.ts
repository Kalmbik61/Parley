/**
 * Уведомления macOS окна (кусок 4.3, спека 7.4): переход сессии в «ждёт тебя» или «закончил
 * ход», новое прямое письмо человеку, уведомления хоста о запуске сессии; с куска 8 «Organic» —
 * решение ведущего, которое ждёт человека в комнате (спека окна 2026-09-29, 1.10); с Parley 0.3.0 —
 * сообщение комнаты, где человека назвали через `@human`. Тексты — из `shared/strings.ts`; название
 * работы и комнаты, ярлык, задача, итог и письмо — данные, идут как есть.
 * Русский `HostNotice.text` сюда не попадает: его пишет в консоль `store/notices.ts`.
 *
 * «Нужен ты» у сессии — уведомление с вопросом: первая строка тела говорит, что именно просят (команда, правка, вопрос,
 * план — `ask-summary.ts`, из ленты сессии), а без карточки — чего ждёт сессия (`need`, причина из `needReason` ядра,
 * спека застрявших 7.4), вторая — проект и сколько ещё сессий ждут. Уведомление уходит через `NEED_SETTLE_MS` после
 * входа в «нужен ты», с последним `need`. Карточка из хука может лечь
 * чуть позже активности, поэтому пустой ответ повторяется один раз через `ASK_RETRY_MS`; если человек успел ответить,
 * уведомления нет. Клик ведёт к самой карточке (`cardId` цели), если ответить можно в окне. Лимит у нескольких сессий
 * одного провайдера — одно уведомление на провайдера (7.1).
 *
 * Звук (спека застрявших 7.2): баннер «нужно действие» всегда беззвучный, а звенит окно своим сигналом (`chime.ts`),
 * на переходе сессии в «нужен ты», один раз: если запрос показывает остров, звучит его сигнал (`useIslandCues`), а окно
 * молчит. Баннер «finished» звучит системным звуком, только если включён `finishedSound` и Done этой сессии не показывает
 * остров: тогда звучит его сигнал `done`, а баннер беззвучный (#9 §3.6).
 *
 * Пока окно острова живо (спека 2026-10-12), запрос с найденной карточкой показывает остров, а не уведомление: двух
 * сигналов об одном и том же не нужно. Codex показывается в острове и без карточки, с переходом к терминалу.
 * У остальных провайдеров без карточки уведомление остаётся.
 */

import type { Message, Proposal, Room, SessionActivity, SessionNeed, WindowWorkEntry, WorkSession } from '@parley/core';
import { localClock, needReason } from '@parley/core/stuck';
import { refKey, type HostNotice, type RoomsMailEvent, type SessionRef } from '@parley/protocol';
import { clampNoteText } from '../../shared/app-note.js';
import type { AppNote, FocusTarget, ParleyBridge } from '../../shared/bridge.js';
import { noticeText, providerName, S } from '../../shared/strings.js';
import type { UiFile } from '../../shared/ui-types.js';
import { replyExcerpt } from '../components/rooms/excerpt.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import { sessionRowLabel, sessionTag, workTitleText } from '../lib/participant.js';
import { projectName } from '../lib/project-name.js';
import { hostMethods } from '../lib/capabilities.js';
import { isRoomArchived } from '../lib/room-archive.js';
import { workKey } from '../lib/tree-order.js';
import { messageSeq } from '../lib/window-merge.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import {
  humanUnreadLetters,
  humanUnreadMentions,
  isHumanMention,
  isHumanUnread,
  roomAwaitsDecision,
  roomDecisionReturned,
  sessionAttention,
  sessionNeed,
  type Attention,
} from './derive.js';
import { pendingAskOf, type PendingAsk } from './ask-summary.js';
import { windowChime } from './chime.js';
import { visibleSessions } from './seen.js';
import { useWindowNotesStore, type WindowNote } from './window-notes.js';

export interface NotifyDeps {
  notify(note: AppNote): void;
  prefs(): UiFile['notifications'];
  isTargetVisible(target: FocusTarget): boolean;
  /** Снимок работ окна: название работы, сессия (ярлык, задача, summary), письма. */
  entries(): readonly WindowWorkEntry[];
  /**
   * Окно в фокусе и на экране (`windowFocused` и `documentVisible` стора окна): решение показывается карточкой
   * в самом окне (1.10), а не уведомлением macOS — человек и так за окном.
   */
  windowActive(): boolean;
  /** Карточка в окне (1.10): `Open` / `Later`, скрытие через 8 с. */
  showInWindow(note: WindowNote): void;
  /** Решение отвечено: его карточка в окне, если ещё стоит, уходит — `Open` вёл бы к уже принятому. */
  hideInWindow(tag: string): void;
  /**
   * Ждущая ответа карточка ленты сессии (разрешение, вопрос, план): что спрашивают и куда вести клик. `null` —
   * ленты нет (хост старый), карточки ещё нет или запрос не удался; отказ запроса считается тем же `null`.
   */
  pendingAsk(ref: SessionRef): Promise<PendingAsk | null>;
  /**
   * Живо ли окно острова (спека 2026-10-12): пока живо, запрос с найденной карточкой показывает остров, а не
   * уведомление macOS. Codex получает переход к терминалу и без карточки.
   */
  islandOn(): boolean;
  /** Звучит ли остров вообще: громкость его звуков выше 0 («0 — выкл», #9 §5). */
  islandAudible(): boolean;
  /**
   * Свой сигнал «нужно действие» (спека застрявших 7.2): играет окно, не чаще раза в 2 с (`chime.ts`). Решает ли звук
   * звучать — `prefs().sound` — проверяет уведомитель.
   */
  chime(): void;
  /** Имя провайдера для человека (аккаунты — по метке хоста): причина `need` и заголовок уведомления о лимите. */
  providerName(id: string): string;
}

/** Пауза перед повторным запросом карточки: хук с ней может прийти чуть позже события активности. */
const ASK_RETRY_MS = 500;

/**
 * Пауза между входом в «нужен ты» и уведомлением (спека застрявших 3.2, 7.1): `need` за неё уточняется, а «вошла и
 * вышла» не даёт ни баннера, ни звука. Идёт до запроса карточки, поэтому и найденная сразу карточка её не обходит.
 */
export const NEED_SETTLE_MS = 1_000;

/**
 * Уведомления хоста, которые ведут к сессии (таблица спеки 7.4), и событие их заголовка. `trust-wait` и `startup-wait`
 * здесь нет: их заменяет `need` вида `startup`, иначе на один экран пришло бы два уведомления (спека застрявших 7.1).
 */
const NOTICE_EVENT: Partial<Record<HostNotice['kind'], string>> = {
  'launch-failed': S.notifications.launchFailed,
  'resume-failed': S.notifications.resumeFailed,
  'limit-return-blocked': S.notifications.limitReturnBlocked,
};

/**
 * Тело уведомления хоста. У `limit-return-blocked` — текст самого хоста с причиной («The limit has reset, but S03 could
 * not continue: a menu is open in its terminal», спека застрявших 7.4): общая фраза окна причины не знает. Хост пишет его
 * по-английски (`wake/wake-service.ts`); пустой текст — таблица окна. У прочих видов хостовый текст в тело не идёт.
 */
function noticeBody(notice: HostNotice): string {
  if (notice.kind !== 'limit-return-blocked') return noticeText(notice);
  const text = notice.text.trim();
  return text === '' ? noticeText(notice) : text;
}

/** Чего ждёт сессия, пока она «нужен ты»: нужна для текста и для группы «лимит у провайдера». */
interface WaitingNeed {
  ref: SessionRef;
  need: SessionNeed;
}

/** Открытая комната, в которой участвует сессия: её название идёт в хвост текста, а клик по лимиту ведёт в неё. */
function roomOf(entry: WindowWorkEntry, session: WorkSession): Room | undefined {
  return entry.map.rooms.find((room) => !isRoomArchived(room) && room.members.includes(session.id));
}

/**
 * Сессии нет в снимке — уровень по активности, как у живой: `sessionAttention` смотрит только
 * на `lifecycle`, остальные поля ему не нужны.
 */
const LIVE_SESSION = { lifecycle: 'active' } as WorkSession;

/** Тот же литерал, что `HUMAN` в `core/work/types.ts`: из core рендерер берёт только типы (как в `derive.ts`). */
const HUMAN = 'human';

/** Ключ базы писем комнаты (`mailTops`): работа и комната; прямые письма — пустой id, как в `compact.rooms` снимка без писем. */
const mailSlot = (key: string, roomId: string | null): string => `${key}\u0000${roomId ?? ''}`;

/** Письма одной комнаты (`null` — прямые): из события `rooms.mail` или из тех, что окно уже держит. */
interface MailBatch {
  roomId: string | null;
  letters: readonly Message[];
  /** Отметки прочтения, пришедшие вместе с письмами; у держимых писем они уже в `readBy`. */
  reads: ReadonlyArray<{ id: string; reader: string }>;
}

/** То, о чём просят внимания среди писем новее базы. */
interface FreshMail {
  /** Прямые письма человеку. */
  letters: Message[];
  /** Упоминания человека по комнатам. */
  mentioned: Array<{ room: Room; letters: Message[] }>;
}

/** Письма, которые окно держит в карте работы (события, страницы починки и открытия комнаты), по комнатам. */
function heldBatches(entry: WindowWorkEntry): MailBatch[] {
  const byRoom = new Map<string | null, Message[]>();
  for (const message of entry.map.messages) {
    const list = byRoom.get(message.roomId);
    if (list === undefined) byRoom.set(message.roomId, [message]);
    else list.push(message);
  }
  return [...byRoom].map(([roomId, letters]) => ({ roomId, letters, reads: [] }));
}

/**
 * Письма пачек новее базы комнаты (`tops`, спека rooms.mail 6.9): двигает базу до настройки и видимости цели, чтобы
 * включённое позже уведомление старых писем не повторяло, и отбирает то, что просит внимания, по правилам окна:
 * прямые письма — `isHumanUnread`, упоминания — ещё и `isHumanMention`, в открытой комнате. Письмо уведомляет один раз,
 * каким бы путём оно ни пришло — событием или страницей: тот путь, что пришёл первым, подвинул базу, второй молчит.
 */
function freshMail(tops: Map<string, number>, key: string, entry: WindowWorkEntry, batches: readonly MailBatch[]): FreshMail {
  const letters: Message[] = [];
  const mentioned: Array<{ room: Room; letters: Message[] }> = [];
  for (const batch of batches) {
    const slot = mailSlot(key, batch.roomId);
    const seen = tops.get(slot) ?? 0;
    const fresh = batch.letters.filter((message) => messageSeq(message) > seen);
    if (fresh.length === 0) continue;
    tops.set(slot, fresh.reduce((top, message) => Math.max(top, messageSeq(message)), seen));
    // Отметка человека в этой же пачке — письмо прочитано, как если бы оно пришло с `readBy.human`.
    const readByHuman = new Set(batch.reads.filter((read) => read.reader === HUMAN).map((read) => read.id));
    const unread = fresh.filter((message) => isHumanUnread(message) && !readByHuman.has(message.id));
    if (batch.roomId === null) {
      letters.push(...unread);
      continue;
    }
    const room = entry.map.rooms.find((item) => item.id === batch.roomId);
    // Архивная комната внимания не просит (спека архива комнат, 5.3); комнаты нет в карте — нечем назвать.
    if (room === undefined || isRoomArchived(room)) continue;
    const mentions = unread.filter(isHumanMention);
    if (mentions.length > 0) mentioned.push({ room, letters: mentions });
  }
  return { letters, mentioned };
}

/**
 * Комнаты события для `freshMail`. Комната с `reread` письма почти не несёт: событие урезано потолком кадра или склеено для
 * медленного окна, а письма её окно дочитает страницей, только если комнату откроет. Упоминания человека в ней есть в
 * `mentionCandidates` события — целиком, с текстом, — и уведомляют отсюда: иначе в неоткрытой комнате не уведомил бы никто.
 */
function withCandidates(event: RoomsMailEvent): readonly MailBatch[] {
  return event.rooms.map((room) => {
    if (room.reread !== true) return room;
    const held = new Set(room.letters.map((message) => message.id));
    const extra = event.mentionCandidates.filter((message) => message.roomId === room.roomId && !held.has(message.id));
    return extra.length === 0 ? room : { ...room, letters: [...room.letters, ...extra] };
  });
}

/** Тег решения (1.10): один на комнату — и у уведомления macOS, и у карточки в окне. */
const decisionTag = (key: string, roomId: string): string => `proposal:${key}:${roomId}`;

/** Первая непустая строка: задача или письмо могут начинаться с пустой строки. */
function firstLine(text: string | null): string {
  if (text === null) return '';
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

function findSession(entries: readonly WindowWorkEntry[], ref: SessionRef): { entry: WindowWorkEntry; session: WorkSession } | null {
  const entry = entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
  const session = entry?.map.sessions.find((item) => item.id === ref.sessionId);
  return entry === undefined || session === undefined ? null : { entry, session };
}

export function createAttentionNotifier(deps: NotifyDeps): {
  /** Переход — по sessionAttention (3.2); первое значение сессии — база без уведомления. */
  onActivity(ref: SessionRef, activity: SessionActivity): void;
  /**
   * Новые прямые письма человеку (isHumanUnread), новые упоминания человека в комнатах (`@human`, по уведомлению на
   * комнату) и решения ведущих, ждущие человека в комнатах (новое — по новому `id`, переделанное — по выросшему `rev`
   * или по новому `id` после возврата на доработку); первый снимок — база. У работы со снимком версии 2 письма в снимке
   * нет, и по тем же правилам и той же базе (`mailTops`) уведомляют письма новее базы среди держимых окном — дочитанные
   * страницами после разрыва или `reread`. Базу ставит первый снимок работы, которая была до запуска уведомителя, — и у
   * той, что появилась в позднейшем снимке (восстановлена из архива, частичный первый снимок): её письма, что уже были,
   * не уведомляют. У работы, созданной после запуска, базы нет: первое письмо смешанной записи, которое снимок уже
   * считает, уведомляет по событию.
   */
  onWorks(entries: readonly WindowWorkEntry[]): void;
  /**
   * Письма события `rooms.mail` у работы со снимком без писем (`compact.version === 2`, спека rooms.mail 6.9): прямые письма
   * человеку и упоминания в комнатах, в том числе в комнате, письма которой окно не держит. Уведомляет только о письмах
   * новее базы комнаты: базу ставит первый снимок (`top` каждой комнаты), дальше она растёт вместе с письмами, о которых
   * окно знает. Повтор события и письмо, которое снимок уже покрыл, не уведомляют. Письма, что событие не несёт (`reread`,
   * разрыв, потерянное событие), а окно дочитало страницами, уведомляет `onWorks` — если они новее базы. Событие раньше
   * первого снимка — без уведомления. Работа со снимком версии 1 — молчание: её письма уведомляет `onWorks`.
   */
  onMail(event: RoomsMailEvent): void;
  /** trust-wait, launch-failed, resume-failed; ref: null или сессии нет в снимке — без уведомления. */
  onHostNotice(notice: HostNotice): void;
} {
  const levels = new Map<string /* refKey */, Attention>();
  /**
   * Чего ждут сессии, что сейчас на уровне «нужен ты» (`refKey` → ref и последний `need`). Нужна, чтобы текст
   * уведомления, клик по лимиту и группа «лимит у провайдера» опирались на `need`, а не на одну только activity.
   * Сессия вышла из «нужен ты» — записи нет.
   */
  const needs = new Map<string, WaitingNeed>();
  /**
   * Письма и сообщения комнат прошлого снимка (`workKey` + id: id сообщений уникальны только в работе); null — снимка
   * ещё не было.
   */
  let knownLetters: Set<string> | null = null;
  /**
   * У работ со снимком без писем (`compact.version === 2`) снимок письмами не делится, и множества id не из чего собрать:
   * вместо него — номер самого нового письма, о котором окно знает, по комнате (`workKey` + id комнаты, прямые письма —
   * пустой id). Первый снимок работы — первый вызов `onWorks`, в котором работа есть, а не только самый первый, — ставит
   * его по `top` комнат (`seeded`), если работа была до запуска уведомителя (`createdAt` раньше `startedAt`): письма,
   * что уже были, когда окно узнало о ней, не новость. У работы, созданной после запуска, базы нет — её письма новые,
   * даже если снимок, пришедший раньше события смешанной записи, уже считает первое. Письма события и письма, что окно
   * держит (страницы починки), подвигают базу (`freshMail`). Письмо с номером не больше базы — повтор; комнаты без записи
   * (создана после первого снимка работы) база не держит. Позднейшие снимки базу не двигают: запись только писем и снимок
   * после неё не должны проглотить уведомление. null — первого снимка ещё не было.
   */
  let mailTops: Map<string, number> | null = null;
  /** Работы со снимком без писем, которые уведомитель уже видел (`workKey`): базу работе ставит только первый снимок, и только старой. */
  const seeded = new Set<string>();
  /** Запуск уведомителя: работа с `createdAt` раньше него была до окна; не разобрать дату — считается старой (тихая сторона). */
  const startedAt = Date.now();
  const existedBefore = (entry: WindowWorkEntry): boolean => {
    const created = Date.parse(entry.map.work.createdAt);
    return Number.isNaN(created) || created < startedAt;
  };
  /**
   * Решения комнат, о которых окно знает: `workKey` + id комнаты → решение (`id`, `rev`) и ждёт ли оно ещё; null —
   * снимка ещё не было. Записи не удаляются, пока живёт уведомитель: `id` решения не переиспользуется, и работа, на миг
   * выпавшая из снимка, не даст уведомления о том же решении второй раз.
   */
  let knownDecisions: Map<string, { id: string; rev: number; waiting: boolean }> | null = null;

  /** Свой сигнал «нужно действие» — если его не выключил `prefs().sound` (спека застрявших 7.2). */
  const ring = (): void => {
    if (deps.prefs().sound) deps.chime();
  };

  /** Баннер macOS: заголовок и тело режутся до предела; звук решает вызывающий (`silent`). */
  const banner = (note: Omit<AppNote, 'silent'>, silent: boolean): void => {
    deps.notify({ ...note, title: clampNoteText(note.title), body: clampNoteText(note.body), silent });
  };

  /**
   * Уведомление при невидимой цели (7.2). `action` — «нужно действие» (письма и упоминания человека, сбои запуска,
   * `limit-return-blocked`): баннер беззвучный, звенит окно. `finished` — баннер с системным звуком, только если
   * включён `finishedSound` и не `quiet` (Done сыграл остров). Переход в «нужен ты» звонит сам (`notifyNeedsYou`), не
   * здесь: запрос, который показывает остров, звучит сигналом острова, и окно молчит.
   */
  const send = (note: Omit<AppNote, 'silent'>, kind: 'action' | 'finished', quiet = false): void => {
    if (deps.isTargetVisible(note.target)) return;
    banner(note, quiet || kind === 'action' || !deps.prefs().finishedSound);
    if (kind === 'action') ring();
  };

  /**
   * Решение ждёт человека (1.10). Окно в фокусе — карточка в самом окне, иначе уведомление macOS; вкладка комнаты видна —
   * ничего, как у прочих целей (7.2). Тег один на комнату: новое уведомление заменяет прежнее и там, и там. Звенит
   * и то и другое: карточка в окне — тоже «нужно действие».
   */
  const sendDecision = (note: Omit<AppNote, 'silent' | 'title'>): void => {
    if (deps.isTargetVisible(note.target)) return;
    const title = S.notifications.decisionTitle;
    if (deps.windowActive()) {
      deps.showInWindow({ tag: note.tag, title: clampNoteText(title), body: clampNoteText(note.body), target: note.target });
    } else {
      banner({ ...note, title }, true);
    }
    ring();
  };

  const notifyDecision = (entry: WindowWorkEntry, room: Room, proposal: Proposal, change: 'new' | 'revised'): void => {
    // Решение — «нужен ты» (2.7), как `blocked`: тот же ключ настроек.
    if (!deps.prefs().needsYou) return;
    // Ведущий — короткий ярлык `S01`, как в подписях `lead S01` окна и в тексте handoff (`dark-01`).
    const lead = sessionTag(proposal.from);
    sendDecision({
      body: (change === 'new' ? S.notifications.decisionNew : S.notifications.decisionRevised)(room.title, lead),
      tag: decisionTag(workKey(entry.projectPath, entry.map.work.id), room.id),
      target: { kind: 'room', projectPath: entry.projectPath, workId: entry.map.work.id, roomId: room.id },
    });
  };

  /**
   * Сравнивает решения снимка с теми, что окно уже знает. Новый `id` в комнате — «collected positions», а если прежнее
   * решение человек вернул на доработку (`roomDecisionReturned`) — «revised»: ведущий принёс исправленное, и новый `id`
   * тут не признак нового решения. Тот же `id` с выросшим `rev` — тоже «revised» (замена до ответа); то же самое
   * решение (`id` и `rev`) молчит. Первый снимок — база: решения, что уже ждали на старте окна или после переподключения
   * к хосту, не уведомляют второй раз (как письма, спека 7.4).
   */
  const trackDecisions = (entries: readonly WindowWorkEntry[]): void => {
    const isBase = knownDecisions === null;
    const known = (knownDecisions ??= new Map());
    for (const entry of entries) {
      const key = workKey(entry.projectPath, entry.map.work.id);
      for (const room of entry.map.rooms) {
        const slot = `${key}\u0000${room.id}`;
        const before = known.get(slot);
        if (!roomAwaitsDecision(room)) {
          // Решение отвечено: карточка о нём в окне больше не нужна.
          if (before?.waiting === true) {
            known.set(slot, { ...before, waiting: false });
            deps.hideInWindow(decisionTag(key, room.id));
          }
          continue;
        }
        const proposal = room.proposal as Proposal;
        known.set(slot, { id: proposal.id, rev: proposal.rev, waiting: true });
        if (isBase) continue;
        if (before === undefined || before.id !== proposal.id) {
          notifyDecision(entry, room, proposal, roomDecisionReturned(entry.map, room.id) ? 'revised' : 'new');
        } else if (proposal.rev > before.rev) notifyDecision(entry, room, proposal, 'revised');
      }
    }
  };

  /**
   * «Нужен ты»: ждёт `NEED_SETTLE_MS`, узнаёт, что спрашивают, и только тогда шлёт (спека застрявших 3.2, 7.1). За
   * паузу `need` успевает уточниться (Codex без OSC 9 даёт `question`, следующий OSC 9 поднимает его до `approval`) —
   * в тексте последний; вышла из «нужен ты» раньше (человек ответил, ход пошёл) — уведомления и сигнала нет. Новый
   * переход в «нужен ты» отменяет предыдущий ещё не отправленный (`attempts`): на одно ожидание — одно уведомление.
   */
  const attempts = new Map<string, number>();
  const notifyNeedsYou = async (ref: SessionRef, key: string): Promise<void> => {
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const stale = (): boolean => attempts.get(key) !== attempt || levels.get(key) !== 'needs-you';
    await new Promise((resolve) => setTimeout(resolve, NEED_SETTLE_MS));
    if (stale()) return;
    const ask = async (): Promise<PendingAsk | null> => deps.pendingAsk(ref).catch(() => null);
    let found = await ask();
    if (found === null) {
      await new Promise((resolve) => setTimeout(resolve, ASK_RETRY_MS));
      found = await ask();
    }
    if (stale()) return;
    const current = findSession(deps.entries(), ref);
    if (current === null) return;
    const { entry, session } = current;
    const waiting = needs.get(key)?.need ?? null;
    const room = waiting === null ? undefined : roomOf(entry, session);
    const sessionTarget: FocusTarget =
      found !== null && found.inWindow ? { kind: 'session', ref, cardId: found.cardId } : { kind: 'session', ref };
    // Лимит решает комната (там ведущий предлагает варианты, 7.1), без комнаты — терминал сессии.
    const target: FocusTarget =
      waiting?.kind === 'limit' && room !== undefined
        ? { kind: 'room', projectPath: entry.projectPath, workId: entry.map.work.id, roomId: room.id }
        : sessionTarget;
    if (deps.isTargetVisible(target)) return;
    // Остров покажет этот запрос сам (спека 2026-10-12), но только у активной работы: у завершённой он запросы
    // пропускает. У Codex есть переход к терминалу и без карточки ленты. Один и тот же признак решает и баннер, и звук.
    const islandShows = deps.islandOn() && entry.map.work.status === 'active' && (found !== null || session.provider === 'codex');
    // Звук — на переходе уровня, а не в `send()`, и ровно один на переход (решение 6): запрос, который показывает
    // остров, звучит его собственным сигналом (`useIslandCues`), поэтому окно молчит; всё прочее — сигнал окна.
    if (islandShows) return;
    ring();
    if (waiting?.kind === 'limit') {
      const now = new Date();
      // Все ждущие лимита сессии этого провайдера (аккаунта): одно уведомление на всех, тег один — оно заменяет прежнее.
      const group = [...needs.values()]
        .filter((item) => item.need.kind === 'limit')
        .flatMap((item) => {
          const other = findSession(deps.entries(), item.ref);
          return other !== null && other.session.provider === session.provider ? [{ id: other.session.id, need: item.need }] : [];
        })
        .sort((a, b) => a.id.localeCompare(b.id, 'en-US', { numeric: true }));
      // Ждут до самого позднего из названных часов; ни одного читаемого — время неизвестно.
      const latest = group
        .flatMap((item) => (item.need.resetsAt !== null && !Number.isNaN(Date.parse(item.need.resetsAt)) ? [item.need.resetsAt] : []))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      banner(
        {
          title: S.need.limitTitle(deps.providerName(session.provider)),
          body: S.need.limitBody(
            group.map((item) => sessionTag(item.id)),
            latest === undefined ? null : localClock(latest, now),
          ),
          tag: `limit:${session.provider}`,
          target,
        },
        true,
      );
      return;
    }
    let more = 0;
    for (const [other, level] of levels) if (other !== key && level === 'needs-you') more += 1;
    // Строка «что просят»: карточка ленты точнее всего (команда, правка, вопрос), без неё — причина `need`, а у хоста
    // прежней версии без `need` — задача сессии, как раньше. Сессия в комнате — `· room <имя>` в конце строки.
    const first =
      found !== null
        ? found.summary
        : waiting !== null
          ? needReason(waiting, new Date(), deps.providerName(session.provider))
          : firstLine(session.task);
    const where = room === undefined ? '' : S.need.inRoom(room.title === '' ? S.rooms.fallbackTitle : room.title);
    const lines = [
      [first, where].filter((part) => part !== '').join(' '),
      S.notifications.waitingLine(projectName(entry.projectPath), more),
    ].filter((line) => line !== '');
    banner(
      {
        title: S.notifications.sessionTitle(
          workTitleText(entry.map.work.title),
          sessionRowLabel(session.id, session.label),
          S.notifications.needsYou,
        ),
        body: lines.join('\n'),
        tag: `session:${key}`,
        target,
      },
      true,
    );
  };

  /** Письмо человеку: одно уведомление на работу (тег `mail:<workKey>`), текст — первая строка письма. */
  const notifyLetter = (entry: WindowWorkEntry, letter: Message): void => {
    send(
      {
        title: S.notifications.mailTitle(workTitleText(entry.map.work.title), letter.kind, sessionTag(letter.from)),
        body: firstLine(letter.text),
        tag: `mail:${workKey(entry.projectPath, entry.map.work.id)}`,
        target: { kind: 'mail', projectPath: entry.projectPath, workId: entry.map.work.id },
      },
      'action',
    );
  };

  /**
   * Упоминание человека в комнате: одно уведомление на комнату (тег `mention:<workKey>:<roomId>`), текст — выдержка
   * (`replyExcerpt`, как у цитаты ответа) из самого позднего нового упоминания. Подписи упоминаний в выдержке — по карте
   * работы, как у чипов ленты: сессии нет в карте — берётся тег.
   */
  const notifyMention = (entry: WindowWorkEntry, room: Room, letter: Message): void => {
    const { projectPath, map } = entry;
    const labelOf = (sessionId: string): string | null => {
      const found = map.sessions.find((candidate) => candidate.id === sessionId);
      return found === undefined ? null : sessionRowLabel(sessionId, found.label);
    };
    send(
      {
        title: S.notifications.mentionTitle(sessionTag(letter.from), room.title === '' ? S.rooms.fallbackTitle : room.title),
        body: replyExcerpt(letter.text, labelOf),
        tag: `mention:${workKey(projectPath, map.work.id)}:${room.id}`,
        target: { kind: 'room', projectPath, workId: map.work.id, roomId: room.id },
      },
      'action',
    );
  };

  /** Пачка — одно уведомление на работу и по одному на комнату: текст — самого позднего письма (как у снимка версии 1). */
  const announce = (entry: WindowWorkEntry, { letters, mentioned }: FreshMail): void => {
    const newest = (list: readonly Message[]): Message | undefined =>
      list.reduce<Message | undefined>((top, message) => (top === undefined || messageSeq(message) > messageSeq(top) ? message : top), undefined);
    const latest = newest(letters);
    if (latest !== undefined) notifyLetter(entry, latest);
    for (const { room, letters: list } of mentioned) {
      const last = newest(list);
      if (last !== undefined) notifyMention(entry, room, last);
    }
  };

  return {
    onActivity(ref, activity) {
      const key = refKey(ref);
      const found = findSession(deps.entries(), ref);
      const level = sessionAttention(found?.session ?? LIVE_SESSION, activity);
      const previous = levels.get(key);
      levels.set(key, level);
      // `need` ведёт только сессия на уровне «нужен ты»: вышла из него — записи нет (у хоста без поля `need` — `null`).
      const need = level === 'needs-you' ? sessionNeed(found?.session ?? LIVE_SESSION, activity) : null;
      if (need === null) needs.delete(key);
      else needs.set(key, { ref, need });
      // Первое значение после подписки — база: хост повторяет новому клиенту активность всех
      // сессий, и без базы каждое подключение давало бы пачку уведомлений (спека 7.4).
      if (previous === undefined || previous === level || found === null) return;
      if (level !== 'needs-you' && level !== 'unseen') return;
      const prefs = deps.prefs();
      if (level === 'needs-you' ? !prefs.needsYou : !prefs.finished) return;
      if (level === 'unseen') {
        const { entry, session } = found;
        // Done активной работы показывает остров и при `finishedSound` играет свой `done` (#9 §3.6): один звук на
        // переход, баннер беззвучный. Признак тот же, что у «нужен ты». С громкостью острова 0 он не сыграет — звенит
        // баннер (критик m-1477).
        const islandShows = deps.islandOn() && deps.islandAudible() && entry.map.work.status === 'active';
        send(
          {
            title: S.notifications.sessionTitle(
              workTitleText(entry.map.work.title),
              sessionRowLabel(session.id, session.label),
              S.notifications.finished,
            ),
            // В `result` только done или failed, текста там нет — итог хода в `summary`.
            body: firstLine(session.summary),
            tag: `session:${key}`,
            target: { kind: 'session', ref },
          },
          'finished',
          islandShows,
        );
        return;
      }
      void notifyNeedsYou(ref, key);
    },

    onWorks(entries) {
      const tops = mailTops ?? new Map<string, number>();
      mailTops = tops;
      const current = new Set<string>();
      // Письма работ со снимком версии 2, которые окно держит и которые новее базы: их принесла страница, а не событие.
      const held: Array<{ entry: WindowWorkEntry; fresh: FreshMail }> = [];
      for (const entry of entries) {
        const key = workKey(entry.projectPath, entry.map.work.id);
        const compact = entry.map.compact;
        // Снимок без писем: базу (`top` каждой комнаты) ставит первый снимок работы (спека rooms.mail 6.9) — и работы,
        // что появилась позже (восстановлена из архива, частичный первый снимок): её держимые письма не новее базы, и с
        // номера 1 они не уведомляют. Работа, созданная после запуска, базы не получает: её письма новые, первое из них
        // снимок мог уже посчитать (смешанная запись), а событие идёт следом. Письма события уведомляет `onMail`. Держимые
        // письма новее базы двигают её и здесь: первый снимок старой работы молчит, как и у версии 1.
        if (compact?.version === 2) {
          const unseen = !seeded.has(key);
          if (unseen) seeded.add(key);
          const silent = unseen && existedBefore(entry);
          if (silent) for (const [roomId, item] of Object.entries(compact.rooms)) tops.set(mailSlot(key, roomId), item.top);
          const fresh = freshMail(tops, key, entry, heldBatches(entry));
          if (!silent) held.push({ entry, fresh });
          continue;
        }
        for (const message of entry.map.messages) current.add(`${key}\u0000${message.id}`);
      }
      const known = knownLetters;
      knownLetters = current;
      trackDecisions(entries);
      // Письма и упоминания, которые уже были на старте окна, не уведомляют.
      if (known === null || !deps.prefs().mail) return;
      for (const entry of entries) {
        if (entry.map.compact?.version === 2) continue;
        const key = workKey(entry.projectPath, entry.map.work.id);
        const fresh = humanUnreadLetters(entry.map).filter((message) => !known.has(`${key}\u0000${message.id}`));
        // Одно уведомление на работу (тег `mail:<workKey>`): новее — последнее письмо.
        const latest = fresh.at(-1);
        if (latest !== undefined) notifyLetter(entry, latest);
      }
      // Упоминания человека в комнатах (`@human`): одно уведомление на комнату, настройка та же, что у писем человеку.
      for (const entry of entries) {
        if (entry.map.compact?.version === 2) continue;
        const key = workKey(entry.projectPath, entry.map.work.id);
        const fresh = humanUnreadMentions(entry.map).filter((message) => !known.has(`${key}\u0000${message.id}`));
        for (const room of entry.map.rooms) {
          const latest = fresh.findLast((message) => message.roomId === room.id);
          if (latest !== undefined) notifyMention(entry, room, latest);
        }
      }
      for (const { entry, fresh } of held) announce(entry, fresh);
    },

    onMail(event) {
      // Первого снимка не было: письма события уже в нём или придут следом — базы для «новее» нет (первое подключение молчит).
      if (mailTops === null) return;
      const entry = deps.entries().find((item) => item.projectPath === event.projectPath && item.map.work.id === event.workId);
      if (entry === undefined || entry.map.compact?.version !== 2) return;
      const fresh = freshMail(mailTops, workKey(event.projectPath, event.workId), entry, withCandidates(event));
      if (!deps.prefs().mail) return;
      announce(entry, fresh);
    },

    onHostNotice(notice) {
      const event = NOTICE_EVENT[notice.kind];
      if (event === undefined || notice.ref === null) return;
      // Сессии нет в снимке — вести некуда и заголовок не из чего собрать.
      const found = findSession(deps.entries(), notice.ref);
      if (found === null) return;
      const { entry, session } = found;
      send(
        {
          title: S.notifications.sessionTitle(workTitleText(entry.map.work.title), sessionRowLabel(session.id, session.label), event),
          // Без ярлыка: он уже в заголовке.
          body: noticeBody(notice),
          tag: `notice:${notice.kind}:${refKey(notice.ref)}`,
          target: { kind: 'session', ref: notice.ref },
        },
        'action',
      );
    },
  };
}

/**
 * Видимость цели по правилам 4.2 (спека 7.2): сессия — её терминал виден (`visibleSessions`);
 * почта и комната — их вкладка активна в своей группе активной работы при фокусе окна и
 * видимом документе. Сторы читаются в момент вызова.
 */
export function isTargetVisible(target: FocusTarget): boolean {
  const ui = useUiStore.getState();
  if (target.kind === 'session') return visibleSessions(ui).has(refKey(target.ref));
  if (!ui.windowFocused || !ui.documentVisible) return false;
  const layoutState = useLayoutStore.getState();
  const key = workKey(target.projectPath, target.workId);
  const layout = layoutState.layouts[key];
  if (layoutState.activeWorkKey !== key || layout === undefined) return false;
  const id = target.kind === 'mail' ? tabId.mail() : tabId.room(target.roomId);
  return groups(layout).some((group) => group.activeTabId === id);
}

/**
 * Окно в фокусе и на экране — то же условие, при котором вкладка комнаты или почты вообще может быть видна
 * (`isTargetVisible`, спека 7.2). Читается в момент вызова.
 */
export function isWindowActive(): boolean {
  const ui = useUiStore.getState();
  return ui.windowFocused && ui.documentVisible;
}

/**
 * Подписки App: useActivityStore (живые события и повтор после подключения), useWorksStore (первый снимок —
 * ответ works.list), host.notice моста. Каждый вызов — новый уведомитель с пустыми базами: App зовёт его
 * на каждый переход в connected. Карточки в окне (1.10) — стор `window-notes.ts`, который рисует `WindowNotes`.
 * Возвращает отписку.
 */
export function wireAttentionNotifications(
  bridge: ParleyBridge,
  deps: Omit<NotifyDeps, 'notify' | 'windowActive' | 'showInWindow' | 'hideInWindow' | 'pendingAsk' | 'islandOn' | 'islandAudible' | 'chime' | 'providerName'>,
): () => void {
  const notifier = createAttentionNotifier({
    ...deps,
    notify: (note) => bridge.app.notify(note),
    // Один сигнал на окно, а не на подключение: пауза в 2 с переживает переподключение к хосту.
    chime: () => windowChime.ring(),
    // Аккаунты (`custom-claude-2`) называются меткой хоста из списка провайдеров; пока списка нет — id.
    providerName: (id) => providerName(id, useProvidersStore.getState().providers.find((provider) => provider.id === id)?.label ?? ''),
    windowActive: isWindowActive,
    showInWindow: (note) => useWindowNotesStore.getState().show(note),
    hideInWindow: (tag) => useWindowNotesStore.getState().dismiss(tag),
    islandOn: () => useUiStore.getState().ui.island.enabled && bridge.app.islandActive(),
    islandAudible: () => useUiStore.getState().ui.island.sound.volume > 0,
    // Ленты нет на старом хосте — вопроса не узнать, уведомление уйдёт с задачей сессии.
    pendingAsk: (ref) =>
      hostMethods(useHostStore.getState().status).has('feed.snapshot')
        ? bridge
            .call('feed.snapshot', { ref, scope: 'attention' })
            .then((snapshot) => pendingAskOf(snapshot, ref.projectPath))
            .catch(() => null)
        : Promise.resolve(null),
  });
  // Активность — из стора, а не прямо из `activity.changed`: повтор после подключения,
  // пришедший раньше подписки рендерера, попадает в стор снимком main (раунд исправлений 3.1).
  // Новое значение сессии — новая запись в `byRef`, повтор того же события — тоже новая.
  const offActivity = useActivityStore.subscribe((state, prev) => {
    for (const [key, entry] of Object.entries(state.byRef)) {
      if (prev.byRef[key] !== entry) notifier.onActivity(entry.ref, entry.activity);
    }
  });
  const offWorks = useWorksStore.subscribe((state, prev) => {
    if (state.entries !== prev.entries) notifier.onWorks(state.entries);
  });
  // Письма окон со снимком без писем приходят событием `rooms.mail`; стор зовёт слушателя после того, как применил его.
  const offMail = useWorksStore.getState().onMail((event) => notifier.onMail(event));
  const offNotice = bridge.on('host.notice', (notice) => notifier.onHostNotice(notice));
  return () => {
    offActivity();
    offWorks();
    offMail();
    offNotice();
  };
}
