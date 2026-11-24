import { localeCatalog } from '@parley/core/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { displayCalendarDay, setAppLocale } from './shared/app-locale.js';
import { collaborationStrings } from './shared/catalogs/collaboration.js';
import { conversationStrings } from './shared/catalogs/conversation.js';
import { islandStrings } from './shared/catalogs/island.js';
import { preferencesStrings } from './shared/catalogs/preferences.js';
import { projectStrings } from './shared/catalogs/project.js';
import { sessionPilotCatalog } from './shared/catalogs/session-pilot.js';
import { nativeWindowStrings, systemStrings } from './shared/catalogs/system.js';
import { toolsStrings } from './shared/catalogs/tools.js';
import { workspaceStrings } from './shared/catalogs/workspace.js';
import { ACTIONS } from './shared/keybindings.js';
import { errorText, noticeText, sessionStateText, S } from './shared/strings.js';

const cyrillic = /\p{Script=Cyrillic}/u;
const placeholders = (message: string): string[] => [...new Set(message.match(/\{\w+\}/g))].sort();

describe('Границы каталогов EN/RU', () => {
  it('в английских каталогах кириллица только в собственном названии русского языка', () => {
    const withCyrillic = (messages: Readonly<Record<string, string>>) =>
      Object.entries(messages).filter(([, message]) => cyrillic.test(message)).map(([key]) => key);

    expect(withCyrillic(localeCatalog.en)).toEqual(['settings.language.ru']);
    expect(localeCatalog.en['settings.language.ru']).toBe('Русский');
    expect(withCyrillic(sessionPilotCatalog.en)).toEqual([]);
  });

  it('русский каталог пилота содержит переводы всех ключей и их параметры', () => {
    expect(Object.keys(sessionPilotCatalog.ru).sort()).toEqual(Object.keys(sessionPilotCatalog.en).sort());
    for (const [key, message] of Object.entries(sessionPilotCatalog.ru)) {
      expect(message, key).toMatch(cyrillic);
      expect(placeholders(message), key).toEqual(placeholders(sessionPilotCatalog.en[key as keyof typeof sessionPilotCatalog.en]));
    }
  });
});

function signatures(value: unknown, prefix = ''): Array<readonly [string, string | number]> {
  if (typeof value === 'function') return [[prefix, value.length]];
  if (typeof value === 'string') return [[prefix, 'text']];
  if (value === null || typeof value !== 'object') throw new Error('Unexpected catalog leaf: ' + prefix);
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, child]) => signatures(child, prefix ? prefix + '.' + name : name));
}

function englishCopy(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(englishCopy);
}

describe('Основные области desktop', () => {
  afterEach(() => setAppLocale('en'));

  it.each([workspaceStrings, collaborationStrings, conversationStrings])('сохраняет ключи и арность шаблонов', ({ en, ru }) => {
    expect(signatures(ru)).toEqual(signatures(en));
    expect(englishCopy(en).filter((message) => cyrillic.test(message))).toEqual([]);
  });

  it('сохраняет пользовательские имена, текст и английские фразы', () => {
    const workspace = 'Alpha / Отчёт';
    const author = 'Agent Иван';
    const answer = 'Keep Исходник verbatim.';
    expect(S.dialogs.newSession.summaryRoom(22, workspace)).toBe('Room with 22 agents in Alpha / Отчёт');
    expect(S.rooms.doingSubagents(2, author)).toBe('2 subagents: Agent Иван');
    expect(S.chat.card.deniedWith(answer)).toBe('Denied · Keep Исходник verbatim.');
    expect(errorText('bad_request', S.errors.actions.createRoom)).toBe("Couldn't create room: invalid request.");

    setAppLocale('ru');
    expect(S.dialogs.newSession.summaryRoom(22, workspace)).toBe('Комната · 22 агента · работа «Alpha / Отчёт»');
    expect(S.rooms.doingSubagents(2, author)).toBe('2 субагента: Agent Иван');
    expect(S.chat.card.deniedWith(answer)).toBe('Отклонено · Keep Исходник verbatim.');
    expect(errorText('bad_request', S.errors.actions.createRoom)).toBe('Не удалось создать комнату: некорректный запрос.');
    expect(S.plans.progress('verified', 5, 21, 2)).toBe('Проверено 5 из 21 · принято по чек-листу: 2');
    expect(sessionStateText('exited', 'closed')).toBe('закрыта');
    expect(sessionStateText('exited', 'sleeping')).toBe('спит');
    expect(ACTIONS.find((action) => action.id === 'work.new')?.title).toBe('Новая работа');
  });

  it('выбирает формы счётчиков с целыми и дробными числами', () => {
    setAppLocale('ru');
    const counts = [0, 1, 2, 5, 11, 21, 22, 25, 1.5];
    expect(counts.map(S.rooms.agentCount)).toEqual([
      '0 агентов', '1 агент', '2 агента', '5 агентов', '11 агентов',
      '21 агент', '22 агента', '25 агентов', '1,5 агента',
    ]);
  });
});

describe('Покрытие desktop и системных поверхностей', () => {
  afterEach(() => setAppLocale('en'));

  it('покрывает все исходные группы S и оставляет исходник для агентского контекста', () => {
    const areas = [workspaceStrings, collaborationStrings, conversationStrings, islandStrings, preferencesStrings, projectStrings, systemStrings, toolsStrings];
    const groups = areas.flatMap(({ en }) => Object.keys(en)).filter((key) => key !== 'recipeMode');
    expect([...groups, 'contextFile'].sort()).toEqual(Object.keys(S).sort());
    expect(new Set(groups).size).toBe(groups.length);
    for (const area of [...areas, nativeWindowStrings]) {
      expect(signatures(area.ru)).toEqual(signatures(area.en));
      expect(englishCopy(area.en).filter((message) => cyrillic.test(message))).toEqual([]);
    }

    const context = S.contextFile;
    const playbook = S.recipes.playbookTemplate;
    const compact = S.context.roomDefault;
    const review = S.notes.header;
    const merge = S.changes.askAgentInstruction;
    setAppLocale('ru');
    expect(S.contextFile).toBe(context);
    expect(S.recipes.playbookTemplate).toBe(playbook);
    expect(S.context.roomDefault).toBe(compact);
    expect(S.notes.header).toBe(review);
    expect(S.changes.askAgentInstruction).toBe(merge);
  });

  it('локализует новые экраны и сохраняет данные провайдеров и состояния хоста', () => {
    const machine = { live: 5, limit: 5, queued: 2, pressure: 'critical' };
    expect(S.board.title).toBe('Board');
    expect(S.chat.composer.kimiLabel).toBe('Message to Kimi Code');
    expect(S.capacity.segment(machine)).toBe('Agents 5/5 · 2 queued · memory critical');

    setAppLocale('ru');
    expect(S.board.title).toBe('Доска');
    expect(S.chat.composer.kimiLabel).toBe('Сообщение для Kimi Code');
    expect(S.browser.cert.title('example.com')).toContain('example.com');
    expect(S.browser.cert.title('example.com')).toMatch(cyrillic);
    expect(S.capacity.segment(machine)).toBe('Агенты 5/5 · В очереди: 2 · память: критическая нагрузка');
    expect(ACTIONS.find((action) => action.id === 'chat.find')?.title).toBe('Найти в чате');
  });

  it('показывает русские даты, числа, доступные названия и уведомления', () => {
    expect(displayCalendarDay('2026-11-24T23:59:59Z')).toBe('2026-11-24');
    setAppLocale('ru');
    expect(displayCalendarDay('2026-11-24T23:59:59Z')).toMatch(/24 нояб/);
    expect(S.settings.projectsGrantedAt('2026-11-24T12:00:00Z')).toMatch(/24 нояб/);
    expect(S.browser.devtools.ms(1250)).toBe('1,25 с');
    expect(S.browser.target.added(22, 'annotations', 'Alpha Иван')).toBe('Добавлено: 22 аннотации · «Alpha Иван»');
    expect(S.island.capsule.agents).toBe('Агенты Parley');
    expect(S.backlog.suggestedLabel).toBe('Предложения');
    expect(noticeText({ kind: 'launch-failed', ref: null, at: '', text: 'technical detail' }, 'S01 Alpha'))
      .toBe('S01 Alpha: не удалось запустить сессию.');
  });
});
