import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkSession } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
// Указатель — из исходников core (корневой `@parley/core` под jsdom не грузится, см. chat/items/items.test.tsx):
// копия выражений в окне должна узнавать ровно то, что core набирает в терминал.
import { oneLine } from '../../../../core/src/counters.js';
import { isPointerText, pointerText } from '../../../../core/src/work/delivery.js';
import { defaultSessionName, NAMES } from '../../../../core/src/work/names.js';
import type { Message, Room } from '../../../../core/src/work/types.js';
import { sessionLabelFor, sessionLabelText, sessionRowLabel, workTitleText } from './participant.js';

describe('sessionRowLabel', () => {
  // Спека архива комнат, часть 2, 13: `NEW_LABEL` core ('new session') на диске старой карты окно показывает именем
  // по номеру сессии, а не «New session».
  it('метка новой сессии из core — имя по номеру сессии, обычная — как есть', () => {
    expect(sessionRowLabel('s-01', 'new session')).toBe(`S01 ${NAMES[0]}`);
    expect(sessionRowLabel('s-18', 'new session')).toBe('S18 Nina');
    expect(sessionRowLabel('s-02', 'new')).toBe('S02 new');
  });

  it('прежняя русская запись метки (карта старой сборки) — тоже имя по номеру', () => {
    expect(sessionRowLabel('s-01', 'новая сессия')).toBe(`S01 ${NAMES[0]}`);
    expect(sessionRowLabel('s-02', 'новая')).toBe('S02 новая');
  });

  it('имя по номеру то же, что даёт core, и после полного круга с номером круга', () => {
    for (const number of [1, 2, 17, 18, 60, 61, 120, 121]) {
      const id = `s-${String(number).padStart(2, '0')}`;
      expect(sessionRowLabel(id, 'new session'), id).toBe(`${id.replace('s-', 'S')} ${defaultSessionName(id)}`);
    }
    expect(sessionRowLabel('s-61', 'new session')).toBe(`S61 ${NAMES[0]} 2`);
  });

  it('свой ярлык, даже совпавший с чужим именем из списка, не трогается', () => {
    expect(sessionRowLabel('s-01', 'Ralph')).toBe('S01 Ralph');
  });

  it('id не вида s-NN имени не получает — прежнее «New session»', () => {
    expect(sessionRowLabel('manual-123', 'new session')).toBe('manual-123 New session');
    expect(sessionLabelText('new session', 'manual-123')).toBe('New session');
  });

  it('s-03 → S03, склеивается с ярлыком', () => {
    expect(sessionRowLabel('s-03', 'бэкенд')).toBe('S03 бэкенд');
  });

  it('пустой ярлык — только тег', () => {
    expect(sessionRowLabel('s-01', '')).toBe('S01');
  });

  it('чужая форма id печатается как есть', () => {
    expect(sessionRowLabel('manual-123', 'ручная')).toBe('manual-123 ручная');
  });
});

describe('указатель на письма вместо ярлыка (автозаголовок сборок до 0.7.0 включительно)', () => {
  const letter = (roomId: string | null): Message => ({
    id: 'm-01',
    roomId,
    from: 's-02',
    to: roomId === null ? ['s-01'] : [],
    at: '2026-10-07T10:00:00.000Z',
    text: 'hi',
    kind: 'note',
    readBy: {},
  });
  const room = (title: string): Room => ({
    id: 'r-01',
    title,
    creator: 's-01',
    members: ['s-02'],
    createdAt: '2026-10-07T10:00:00.000Z',
    lead: null,
    proposal: null,
  });

  it('ярлык из карты пользователя — имя по номеру, текст указателя на месте имени не показывается', () => {
    expect(sessionRowLabel('s-01', 'New messages (1) in r-01 "Second". Call check_inbox.')).toBe(`S01 ${NAMES[0]}`);
  });

  it('каждый указатель core — и как есть, и после oneLine с обрезкой длинного названия комнаты — имя по номеру', () => {
    const texts = [
      pointerText([letter(null)], []),
      pointerText([letter('r-01')], [room('Second')]),
      pointerText([letter('r-01'), { ...letter(null), id: 'm-02' }], [room('Second')]),
      pointerText([letter('r-01')], [room('long room title '.repeat(12))]),
    ];
    for (const text of texts) {
      for (const label of [text, oneLine(text)]) {
        expect(isPointerText(label), label).toBe(true);
        expect(sessionLabelText(label, 's-18'), label).toBe('Nina');
      }
    }
    expect(workTitleText(texts[1]!)).toBe('Untitled workspace');
  });

  it('похожее, но своё имя — как есть', () => {
    expect(sessionRowLabel('s-01', 'New messages handling')).toBe('S01 New messages handling');
    expect(sessionLabelText('New messages (1). Call check_inbox. And fix the parser', 's-01')).toBe(
      'New messages (1). Call check_inbox. And fix the parser',
    );
  });
});

describe('workTitleText', () => {
  it('метка безымянной работы из core — «Untitled workspace»', () => {
    expect(workTitleText('untitled')).toBe('Untitled workspace');
  });

  it('прежняя русская запись метки (карта старой сборки) — тоже «Untitled workspace»', () => {
    expect(workTitleText('без названия')).toBe('Untitled workspace');
  });

  it('обычное название — как есть, в том числе похожее на метку', () => {
    expect(workTitleText('Авторизация')).toBe('Авторизация');
    expect(workTitleText('Untitled')).toBe('Untitled');
    expect(workTitleText('')).toBe('');
  });
});

function session(id: string, label = ''): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function entry(projectPath: string, workId: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: workId, title: 'Work', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

// Раунд исправлений 1 куска E.1: ярлык для `noticeText` в строке статуса
// (`shell/AppShell.tsx`) и уведомлении trust-wait (`App.tsx`).
describe('sessionLabelFor', () => {
  const ref: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-03' };

  it('находит сессию по адресу и отдаёт S03 + ярлык', () => {
    const entries = [entry('/tmp/p', 'w-01', [session('s-03', 'backend')])];
    expect(sessionLabelFor(entries, ref)).toBe('S03 backend');
  });

  it('ref: null — undefined (уведомления о карте, не о сессии)', () => {
    expect(sessionLabelFor([entry('/tmp/p', 'w-01', [session('s-03')])], null)).toBeUndefined();
  });

  it('сессия пропала из снимка — undefined, а не сырой sessionId', () => {
    expect(sessionLabelFor([entry('/tmp/p', 'w-01', [])], ref)).toBeUndefined();
  });

  it('работа с таким адресом не найдена — undefined', () => {
    expect(sessionLabelFor([], ref)).toBeUndefined();
  });
});
