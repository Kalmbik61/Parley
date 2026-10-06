import { z } from 'zod';
import type {
  FeedCardState,
  FeedItem,
  ParleyConfig,
  MergeCheck,
  MergeResult,
  ProjectChanges,
  WorktreeDiff,
} from '@parley/core';
import { feedDecision } from './feed.js';
import type { Capabilities, ModelOption, ProviderCheck, ProviderLimits, SendResult, SessionRef, WorksSnapshot } from './types.js';

export const sessionRef = z.object({
  projectPath: z.string(),
  workId: z.string(),
  sessionId: z.string(),
});

/** Края названия работы: пробелы и невидимые символы формата (ZWSP, ZWNJ, ZWJ, WJ, BOM). */
const TITLE_EDGES = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

/** Режимы, которые окно выбирает само: цикл Shift+Tab (auto — когда модель его даёт) без обхода разрешений. */
export const permissionModeChoice = z.enum(['default', 'acceptEdits', 'plan', 'auto']);
export type PermissionModeChoice = z.infer<typeof permissionModeChoice>;

/**
 * Токен уровня effort (нормалайзер модели и effort, 5.3): строчная латинская буква, затем до 31 знака
 * из строчных букв, цифр, `_` и `-`. Такой токен безопасен и отдельным элементом argv (`--effort <id>`),
 * и внутри кавычек TOML (`-c model_reasoning_effort="<id>"`). Шаблон — тот же, что `EFFORT_TOKEN` в core:
 * протокол берёт из core только типы, поэтому держит свою копию, а совпадение сверяет тест хоста.
 */
export const EFFORT_TOKEN_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Схемы параметров запросов (с ответом, с числовым `id`). */
export const METHODS = {
  hello: z.object({ token: z.string(), protocol: z.number().int(), client: z.string() }),
  'host.info': z.object({}),
  'host.shutdown': z.object({}),
  'providers.list': z.object({}),
  'providers.refreshLimits': z.object({}),
  'providers.check': z.object({ provider: z.string() }),
  // Key normalization belongs to core: trim edges before checking the length or whitespace.
  'providers.setKey': z.object({ provider: z.string(), key: z.string() }),
  'providers.clearKey': z.object({ provider: z.string() }),
  'works.list': z.object({}),
  'works.create': z.object({ projectPath: z.string(), title: z.string(), goal: z.string() }),
  'works.delete': z.object({ projectPath: z.string(), workId: z.string() }),
  // Предел — по кодовым точкам: `.max(120)` zod считает UTF-16, эмодзи шло бы за два.
  // Сырой предел 480 единиц UTF-16 (4 × 120) — `title.length`, O(1): отсекает
  // заведомый мусор до обрезки и обхода по кодовым точкам. Обрезка — та же, что
  // у `renameWork` в core: невидимые символы формата по краям считаются
  // пробелами, иначе название из одних ZWSP прошло бы.
  'works.rename': z.object({
    projectPath: z.string(),
    workId: z.string(),
    title: z
      .string()
      .refine((title) => title.length <= 480, { abort: true })
      .transform((title) => title.replace(TITLE_EDGES, ''))
      .pipe(
        z
          .string()
          .min(1)
          .refine((title) => [...title].length <= 120),
      ),
  }),
  'works.setStatus': z.object({
    projectPath: z.string(),
    workId: z.string(),
    status: z.enum(['active', 'done', 'archived']),
  }),
  'sessions.create': z.object({
    projectPath: z.string(),
    workId: z.string().nullable(),
    provider: z.string(),
    label: z.string(),
    task: z.string(),
    parent: z.string().nullable(),
    worktree: z.boolean().optional(),
    // Модель и усилие из диалога запуска (дизайн комнат, 3.2). Провайдер без флага их отбрасывает
    // — окно узнаёт об этом из `providers.list`. Модель — `id` из списка провайдера
    // (`providers.list.models`): одно слово, без пробелов и не с дефиса (CLI принял бы её за флаг);
    // принадлежность списку проверяет хост (`bad_request`), схема — только вид. Пустая строка, как
    // и отсутствие поля, — «по умолчанию»: без флага, модель CLI по умолчанию. Усилие — токен уровня
    // (`EFFORT_TOKEN_RE`, нормалайзер модели и effort, 5.6): уровни выбранной модели
    // (`providers.list.models[].efforts`) сверяет хост (`bad_request`), схема — только вид. Прежние
    // `low`, `medium` и `high` старого окна — тоже токены и проходят.
    model: z
      .string()
      .max(200)
      .regex(/^(?:[^\s-]\S*)?$/)
      .optional(),
    effort: z.string().regex(EFFORT_TOKEN_RE).optional(),
  }),
  'sessions.resume': z.object({ ref: sessionRef }),
  'sessions.stop': z.object({ ref: sessionRef }),
  'sessions.delete': z.object({ ref: sessionRef, force: z.boolean().optional() }),
  'sessions.close': z.object({ ref: sessionRef }),
  'sessions.interrupted': z.object({}),
  // Режим разрешений (план 2026-10-01, решение 4): хост жмёт Shift+Tab и сверяет подвал терминала.
  'sessions.setMode': z.object({ ref: sessionRef, mode: permissionModeChoice }),
  // Смена effort идущей сессии из меню чата (нормалайзер модели и effort, 5.7). «По умолчанию» здесь не выбирается:
  // `/effort auto` стёр бы сохранённый уровень человека. Уровни модели сверяет хост (`bad_request`).
  'sessions.setEffort': z.object({ ref: sessionRef, effort: z.string().regex(EFFORT_TOKEN_RE) }),
  // Подсказки поля ввода вида «Chat» (живая проверка 2026-10-02): команды, скиллы и субагенты CLI
  // провайдера у человека и в проекте — хост только читает их папки.
  'capabilities.list': z.object({ projectPath: z.string().min(1), provider: z.string().min(1) }),
  'sessions.resumeInterrupted': z.object({ refs: z.array(sessionRef) }),
  'pty.attach': z.object({ ref: sessionRef }),
  'pty.detach': z.object({ ref: sessionRef }),
  'wake.pause': z.object({}),
  'wake.resume': z.object({}),
  'wake.state': z.object({}),
  'settings.get': z.object({}),
  'settings.set': z.object({ key: z.string(), value: z.string() }),
  'rooms.create': z.object({
    projectPath: z.string(),
    workId: z.string(),
    title: z.string().min(1),
    members: z.array(z.string()).min(1),
    // Ведущий — один из `members`; без него хост берёт первого (дизайн комнат, 3.2). Старый хост
    // поле отбросит, старое окно его не шлёт.
    lead: z.string().optional(),
    // Две сессии, из которых комнату собрали, — диалог 1.6 (дизайн комнат, 2.5): хост пишет системную
    // строку «Room created from @s03 and @s02» в порядке пары. Писать её может только хост, окно
    // такой строки не отправит. Обе — из `members`. Старый хост поле отбросит: строки не будет.
    origin: z.tuple([z.string(), z.string()]).optional(),
    // Тихий старт (дизайн комнат, 2.1, диалог 1.5): участникам не пишутся письма-приглашения, лента
    // комнаты пуста, пока человек не напишет в неё задачу. Без флага приглашения уходят, как прежде:
    // сессии уже работают и о комнате иначе не узнают. Старый хост поле отбросит.
    quiet: z.boolean().optional(),
  }),
  // Дизайн комнат, 3.2: человек вводит сессию в комнату; она уходит из прочих комнат работы. Уже
  // участник и нигде больше — `bad_request`; состоящая и в других комнатах (старая карта, решение 4)
  // остаётся в этой одной.
  'rooms.addMember': z.object({
    projectPath: z.string(),
    workId: z.string(),
    roomId: z.string(),
    sessionId: z.string(),
  }),
  // Ответ человека на решение ведущего. Устаревший `proposalId` хост отвергает как `conflict`;
  // заметка возврата — до 4000 знаков, длиннее не проходит схему. `rev` — версия карточки, которую
  // человек видел (`Proposal.rev`): пока карточка висела, ведущий мог заменить текст (`id` тот же, `rev`
  // больше), и без `rev` `Accept` принял бы текст, которого человек не видел. Не совпал — `conflict`.
  // Старый хост поле отбросит, старое окно его не шлёт: тогда сверяется один `proposalId`.
  'rooms.resolveProposal': z.object({
    projectPath: z.string(),
    workId: z.string(),
    roomId: z.string(),
    proposalId: z.string(),
    action: z.enum(['accept', 'return']),
    note: z.string().max(4000).optional(),
    rev: z.number().int().min(0).optional(),
  }),
  'rooms.send': z.object({
    projectPath: z.string(),
    workId: z.string(),
    roomId: z.string().nullable(),
    to: z.array(z.string()),
    text: z.string().min(1),
    kind: z.enum(['note', 'question', 'decision']),
  }),
  'worktrees.available': z.object({ projectPath: z.string() }),
  // `patch` только добавлен: старый хост его отбросит, старое окно не шлёт. false — `patch: ''`.
  'worktrees.diff': z.object({ ref: sessionRef, patch: z.boolean().optional() }),
  'worktrees.commit': z.object({ ref: sessionRef, message: z.string().min(1) }),
  'worktrees.merge': z.object({ ref: sessionRef }),
  'worktrees.discard': z.object({ ref: sessionRef, force: z.boolean() }),
  // Этап 8: конфликты до слияния и изменения папки проекта для сессии без worktree (спека 3.2, 11.5).
  'worktrees.mergeCheck': z.object({ ref: sessionRef }),
  'changes.project': z.object({ ref: sessionRef, patch: z.boolean().optional() }),
  'changes.commitProject': z.object({ ref: sessionRef, message: z.string().min(1).max(10000) }),
  // Пачка окна — до 500 id (500 мс тишины); пустую слать незачем.
  'mail.markRead': z.object({
    projectPath: z.string(),
    workId: z.string(),
    messageIds: z.array(z.string()).min(1).max(500),
  }),
  // Предел 64 КиБ хост считает в байтах UTF-8 после очистки (спека 8.6, шаг 2): схема
  // байтов не видит, поэтому здесь только «не пусто».
  'pty.send': z.object({ ref: sessionRef, text: z.string().min(1), submit: z.boolean() }),
  // Лента вида «Chat» (план 2026-10-01, Task 2, решение 14). `agentId` — лента субагента из его
  // журнала: id идёт в путь `subagents/agent-<id>.jsonl`, поэтому только буквы, цифры, `_` и `-`.
  'feed.snapshot': z.object({
    ref: sessionRef,
    agentId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,80}$/)
      .optional(),
  }),
  'feed.subscribe': z.object({ ref: sessionRef }),
  'feed.unsubscribe': z.object({ ref: sessionRef }),
  // Решение человека — единственный путь, которым `allow`/`deny` доходит до хука (Review Focus 5).
  'feed.decide': z.object({ ref: sessionRef, cardId: z.string().max(200), decision: feedDecision }),
  // «Stop» вида «Chat»: Esc агенту по нажатию человека; хост сам закрывает в ленте ход, который CLI бросил
  // без записи, и стирает из поля ввода терминала возвращённый туда текст промпта.
  'feed.interrupt': z.object({ ref: sessionRef }),
} as const;

// Уведомления клиента — без id и без ответа: их слишком много, чтобы ждать каждое.
export const NOTIFICATIONS = {
  'pty.input': z.object({ ref: sessionRef, data: z.string() }),
  'pty.resize': z.object({ ref: sessionRef, cols: z.number().int().min(2), rows: z.number().int().min(2) }),
  // Окно видит терминал сессии — «просмотрено» ставит видимость, а не подключение (спека 7.2).
  'activity.seen': z.object({ ref: sessionRef }),
} as const;

export interface Results {
  /** `methods` — все методы и уведомления хоста; нет поля — хост до этапа 3 (спека 3.2). */
  hello: { hostVersion: string; protocol: number; pid: number; methods?: string[] };
  'host.info': { hostVersion: string; pid: number; startedAt: string; clients: number; liveSessions: number };
  'host.shutdown': { ok: true };
  /** Перечитаны источники CLI и запрошена квота подключённого Z.ai; свежесть зависит от источника. */
  'providers.refreshLimits': { ok: true };
  /**
   * Явная проверка сохранённого ключа тестовым сообщением (только у провайдера с ключом — GLM).
   * `null` — провайдер не готов локально (нет CLI нужной версии или ключа: см. `providers.list.needs`),
   * и запроса в сеть не было. Исход хост запоминает: дальше он приходит полем `providers.list.check`.
   */
  'providers.check': { check: ProviderCheck | null };
  'providers.list': {
    providers: Array<{
      id: string;
      label: string;
      available: boolean;
      /** Missing CLI/version, missing saved key, or ready; optional for older hosts. */
      needs?: 'cli' | 'key' | null;
      /** Only a masked hint is returned for providers that use a saved key. */
      keyHint?: string | null;
      /** Trusted built-in CLI family; older hosts omit this field. */
      family?: 'claude' | null;
      // Три поля ниже необязательны, как `hello.methods`: хост переживает окно, а `PROTOCOL_VERSION`
      // остаётся 1, поэтому новое окно с хостом, оставшимся с живыми сессиями, получит элементы без
      // них. Нынешний хост отдаёт их всегда; нет поля — окно читает «контрола нет» и «версии нет».
      /**
       * Модели для выбора при запуске — пары `id` (значение `--model`) и `label` (подпись окна),
       * в порядке документации провайдера. «По умолчанию» в списке нет: это отсутствие выбора
       * (`sessions.create` без `model` или с пустой). `null` — списка нет: окно контрол не
       * показывает; хост тогда принимает любую модель, а провайдер без `{model}` в шаблоне
       * запуска отбрасывает её сам. `efforts` модели — её уровни effort по порядку (нормалайзер
       * модели и effort, 5.1): `null` — уровней нет (Haiku), поля нет — хост до нормалайзера или свой
       * список в `providers.json`; тогда действуют прежние `low`, `medium` и `high`.
       */
      models?: ModelOption[] | null;
      /** Принимает ли провайдер усилие при запуске: нет — окно прячет контрол. */
      effort?: boolean;
      /**
       * `args` провайдера заменены записью `providers.json` (нормалайзер модели и effort, 5.6): без
       * `{model}` или `{effort}` в них выбор модели или усилия выключен, и карточка провайдера объясняет
       * почему. Поля нет — замены нет или хост до нормалайзера.
       */
      argsOverridden?: boolean;
      /** Версия CLI из пробы на старте хоста; `null` — не узнали. */
      version?: string | null;
      /**
       * Лимиты подписки из CLI, для GLM — подтверждённая квота Z.ai (`source: 'zai'`).
       * `null` — данных нет или окна уже сбросились. Необязательно, как три поля выше, по той же причине.
       * Дальше числа приходят событием `providers.limitsChanged`.
       */
      limits?: ProviderLimits | null;
      /**
       * Исход последней явной проверки сохранённого ключа (`providers.check`), только у GLM. `null` —
       * не проверяли или ключ с тех пор сменился. Необязательно по той же причине, что `limits`:
       * хост, оставшийся с живыми сессиями, может не знать поля.
       */
      check?: ProviderCheck | null;
    }>;
  };
  'providers.setKey': { keyHint: string };
  'providers.clearKey': { ok: true };
  'works.list': WorksSnapshot;
  'works.create': { workId: string };
  'works.delete': { ok: true };
  'works.rename': { ok: true };
  'works.setStatus': { ok: true };
  'sessions.create': { ref: SessionRef };
  'sessions.resume': { ok: true };
  'sessions.stop': { ok: true };
  'sessions.delete': { ok: true };
  'sessions.close': { ok: true };
  'sessions.interrupted': { refs: SessionRef[] };
  /** `mode` — что показал подвал (сырая строка CLI, `null` — подвала не нашли); `verified` — сошлось с целью. */
  'sessions.setMode': { mode: string | null; verified: boolean };
  /**
   * Смена effort ползунком `/effort` (нормалайзер модели и effort, 5.7). `effort` — уровень, который
   * показал подвал CLI (`null` — подвала не нашли); `verified` — он совпал с целью, и хост записал его в
   * карту. Не совпал — карта не меняется.
   */
  'sessions.setEffort': { effort: string | null; verified: boolean };
  /** Списки отсортированы по имени; у провайдера без поддержки (Codex) — пустые. */
  'capabilities.list': Capabilities;
  'sessions.resumeInterrupted': { ok: true };
  'pty.attach': { snapshot: string; cols: number; rows: number };
  'pty.detach': { ok: true };
  'wake.pause': { paused: boolean };
  'wake.resume': { paused: boolean };
  'wake.state': { paused: boolean };
  'settings.get': { config: ParleyConfig; locked: Record<string, string> };
  'settings.set': { config: ParleyConfig };
  'rooms.create': { roomId: string };
  /** `messageId` — системная строка ленты «@s04 joined the room». */
  'rooms.addMember': { messageId: string };
  /** `messageId` — сообщение `decision` при `accept`, письмо ведущему при `return`. */
  'rooms.resolveProposal': { messageId: string };
  'rooms.send': { messageId: string };
  'worktrees.available': { available: boolean };
  'worktrees.diff': WorktreeDiff;
  'worktrees.commit': { commit: string };
  'worktrees.merge': MergeResult;
  'worktrees.discard': { ok: true };
  'worktrees.mergeCheck': MergeCheck;
  'changes.project': ProjectChanges;
  'changes.commitProject': { commit: string };
  'mail.markRead': { marked: number };
  'pty.send': SendResult;
  /**
   * `schemaVersion` — `FEED_SCHEMA_VERSION` хоста; дальше дельты `feed.changed` по `revision`.
   * `mode` — режим разрешений сессии (сырая строка CLI), `null` — не известен.
   */
  'feed.snapshot': { items: FeedItem[]; revision: number; schemaVersion: number; mode: string | null };
  'feed.subscribe': { ok: true };
  'feed.unsubscribe': { ok: true };
  /** `applied: false` — карточка уже не ждёт (ответили в терминале, второе нажатие); `state` — её состояние. */
  'feed.decide': { applied: boolean; state: FeedCardState };
  'feed.interrupt': { ok: true };
}

export type MethodName = keyof typeof METHODS;
export type NotificationName = keyof typeof NOTIFICATIONS;

export type Params<M extends MethodName | NotificationName> = z.infer<
  (typeof METHODS & typeof NOTIFICATIONS)[M]
>;
export type Result<M extends MethodName> = Results[M];
