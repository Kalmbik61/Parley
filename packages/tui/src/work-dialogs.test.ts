import type { WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { glyphs } from './glyphs.js';
import {
  launchDialog,
  newSessionDialog,
  newWorkDialog,
  resumeDialog,
  resumePreview,
  summaryDialog,
} from './work-dialogs.js';
import type { WorkRowSession } from './work-rows.js';

const g = glyphs({ LC_ALL: 'ru_RU.UTF-8' });

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-04',
    provider: 'codex',
    label: 'бэкенд',
    task: 'шаги 1–3',
    parent: null,
    contextFrom: [],
    status: 'exited',
    history: [
      { status: 'active', at: '2026-09-02T13:00:00.000Z' },
      { status: 'exited', at: '2026-09-02T14:02:00.000Z', exitCode: 0 },
    ],
    startedAt: '2026-09-02T13:00:00.000Z',
    endedAt: '2026-09-02T14:02:00.000Z',
    providerSessionId: '7fa0e1ee-cc7b',
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

const row = (over: Partial<WorkSession> = {}): WorkRowSession => ({
  kind: 'session',
  key: '/dev/shop w-0042 s-04',
  projectPath: '/dev/shop',
  workId: 'w-0042',
  startsProject: false,
  session: session(over),
  depth: 0,
  unread: 0,
  inbox: [],
  live: { durationMs: null, tokens: null, model: null, lastRecordAt: null },
});

describe('диалог новой работы (4.1)', () => {
  it('спрашивает заголовок и цель, проект только показывает', () => {
    const spec = newWorkDialog('/dev/shop');
    expect(spec.fields.map((field) => field.key)).toEqual(['title', 'goal']);
    // Цель можно оставить пустой, заголовок — нет.
    expect(spec.fields[0]?.optional).toBeUndefined();
    expect(spec.fields[1]?.optional).toBe(true);
    expect(spec.info[0]).toContain('/dev/shop');
    expect(spec.footer).toContain('Esc');
  });
});

describe('диалог новой сессии (4.2)', () => {
  const providers = [
    { id: 'claude', label: 'Claude', available: true },
    { id: 'glm', label: 'GLM', available: false, note: 'нет в PATH' },
  ];

  it('провайдер — селектор по реестру, недоступный помечен прямо в кольце', () => {
    const spec = newSessionDialog('Авторизация', providers);
    expect(spec.title).toContain('Авторизация');
    expect(spec.fields.map((field) => field.key)).toEqual(['provider', 'label', 'task']);
    // Пометка едет с самим вариантом: отдельной строкой не видно, где в кольце
    // пропуск (дизайн 4.2).
    expect(spec.fields[0]?.options).toEqual([
      { id: 'claude', label: 'Claude' },
      { id: 'glm', label: 'GLM', disabled: true, note: 'нет в PATH' },
    ]);
    expect(spec.info).toEqual([]);
  });
});

/** 26 знаков — левая колонка на 80×24, 41 — на 120×40 (макеты 4.3 и 4.4). */
const NARROW = 26;
const WIDE = 41;

describe('диалог запуска (4.3)', () => {
  it('на широкой колонке путь брифа виден от корня проекта', () => {
    const spec = launchDialog(row({ status: 'pending' }), '# Работа\n', g, WIDE);
    expect(spec.info).toEqual(['бриф: .harnas/works/w-0042/briefs/s-04.md']);
    expect(spec.title).toContain('(Codex)');
  });

  it('на узкой остаётся короткая форма и двухсимвольная марка', () => {
    const spec = launchDialog(
      row({ status: 'pending' }),
      '# Работа\n\nЗадача: шаги 1–3\n',
      g,
      NARROW,
    );
    expect(spec.title).toContain('ЗАПУСК');
    expect(spec.title).toContain('бэкенд');
    expect(spec.title).toContain('(Cx)');
    expect(spec.info).toEqual(['бриф: briefs/s-04.md']);
    expect(spec.quote[0]).toBe('# Работа');
    // Полей нет: бриф правится своим редактором, а не в TUI (решение №1).
    expect(spec.fields).toEqual([]);
  });
});

describe('диалог возобновления (4.4)', () => {
  it('для exited показывает время выхода, код и отсутствие отчёта', () => {
    const spec = resumeDialog(row(), 'codex resume 7fa0e1ee-cc7b', g, WIDE);
    expect(spec.title).toContain('ВОЗОБНОВИТЬ');
    expect(spec.title).toContain('(Codex)');
    // На узкой колонке провайдера в заголовке нет: место занимает роль (макет 4.4).
    expect(resumeDialog(row(), 'codex resume 7fa0e1ee-cc7b', g, NARROW).title).not.toContain(
      'Codex',
    );
    expect(spec.info[0]).toBe('codex resume 7fa0e1ee-cc7b');
    expect(spec.info[1]).toContain('вышел');
    expect(spec.info[1]).toContain('код 0');
    expect(spec.info[2]).toContain('отчёта не было');
  });

  it('сигнал важнее кода выхода', () => {
    const spec = resumeDialog(
      row({
        history: [{ status: 'exited', at: '2026-09-02T14:02:00.000Z', exitCode: 0, signal: 9 }],
      }),
      'codex resume 7fa0e1ee-cc7b',
      g,
      WIDE,
    );
    expect(spec.info[1]).toContain('сигнал 9');
  });

  it('у завершённой сессии резюме помечено как перезаписываемое', () => {
    const spec = resumeDialog(
      row({ status: 'done', summary: 'План готов: 5 шагов', summarySource: 'agent' }),
      'codex resume 7fa0e1ee-cc7b',
      g,
      WIDE,
    );
    expect(spec.title).toContain(g.done);
    expect(spec.info[2]).toContain('План готов');
    expect(spec.info[2]).toContain('будет перезаписано');
  });
});

describe('команда возобновления в диалоге', () => {
  it('обрывается на id сессии: длинных аргументов в макете нет', () => {
    const preview = resumePreview(
      'codex',
      ['resume', '7fa0e1ee-cc7b', '-c', 'mcp_servers.harnas={…}'],
      '7fa0e1ee-cc7b',
    );
    expect(preview).toBe('codex resume 7fa0e1ee-cc7b');
  });

  it('без id у провайдера честно говорит, что процесс будет новым', () => {
    expect(resumePreview('codex', ['-c', 'x', 'бриф'], null)).toContain('новый процесс по брифу');
  });
});

describe('диалог дозаказа резюме (4.5)', () => {
  it('объясняет, чем считается и как запишется, и ничего не спрашивает', () => {
    const spec = summaryDialog(row(), g, WIDE);
    expect(spec.title).toContain('РЕЗЮМЕ');
    expect(spec.title).toContain('бэкенд');
    expect(spec.title).toContain(g.exited);
    // Полей нет: диалог только подтверждает (макет 4.5).
    expect(spec.fields).toEqual([]);
    expect(spec.info.join(' ')).toContain('claude -p');
    expect(spec.info.join(' ')).toContain('авто');
    expect(spec.footer).toContain('Enter — заказать');
    expect(spec.footer).toContain('Esc');
  });

  it('на узкой колонке текст короче, но смысл тот же', () => {
    const spec = summaryDialog(row(), g, NARROW);
    for (const info of spec.info) expect(info.length).toBeLessThanOrEqual(NARROW);
    expect(spec.info.join(' ')).toContain('claude -p');
  });
});
