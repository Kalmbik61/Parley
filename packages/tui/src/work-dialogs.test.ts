import type { WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { glyphs } from './glyphs.js';
import {
  closeSessionDialog,
  deleteBlockedDialog,
  deleteSessionDialog,
  deleteWorkBlockedDialog,
  deleteWorkDialog,
  exitDialog,
  launchDialog,
  resumeDialog,
  resumePreview,
  summaryDialog,
} from './work-dialogs.js';

const g = glyphs({ LC_ALL: 'ru_RU.UTF-8' });

/** Тело подтверждения внутри рамки 48: 48 − 2 бока (§4.0). */
const BODY = 46;

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-04',
    provider: 'claude',
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
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: '7fa0e1ee-cc7b',
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

describe('оверлей запуска (макет 4.5)', () => {
  it('заголовок с глифом, путь брифа от корня проекта и бриф телом', () => {
    const spec = launchDialog(
      '/dev/shop',
      'w-0042',
      session({ status: 'pending' }),
      '# Работа\n\nЗадача: шаги 1–3\n',
      g,
      BODY,
    );
    expect(spec.title).toBe(`запуск ${g.pending} бэкенд`);
    expect(spec.info).toEqual(['бриф: .harnas/works/w-0042/briefs/s-04.md', 'старт: по брифу']);
    expect(spec.quote[0]).toBe('# Работа');
    expect(spec.footer).toContain('Enter — запустить');
    // Провайдер в заголовке не показывается, пока провайдер один (раздел 9).
    expect(spec.title).not.toContain('Claude');
  });

  it('тихая сессия без задачи: старт ждёт запроса пользователя', () => {
    const spec = launchDialog(
      '/dev/shop',
      'w-0042',
      session({ status: 'pending', task: '' }),
      '# Работа\n',
      g,
      BODY,
    );
    expect(spec.info[1]).toBe('старт: ждёт ваш запрос');
  });

  it('в узкую строку едет короткая форма пути', () => {
    const spec = launchDialog('/dev/shop', 'w-0042', session({ status: 'pending' }), '', g, 26);
    expect(spec.info).toEqual(['бриф: briefs/s-04.md', 'старт: по брифу']);
  });
});

describe('оверлей возобновления (макет 4.6)', () => {
  it('для exited показывает команду, время выхода, код и отсутствие отчёта', () => {
    const spec = resumeDialog(session(), 'claude --resume 7fa0e1ee-cc7b', g);
    expect(spec.title).toBe(`возобновить ${g.exited} бэкенд`);
    expect(spec.info[0]).toBe('claude --resume 7fa0e1ee-cc7b');
    expect(spec.info[1]).toContain('вышла');
    expect(spec.info[1]).toContain('код 0');
    expect(spec.info[2]).toContain('R закажет авто-резюме');
    expect(spec.footer).toContain('Enter — возобновить');
  });

  it('сигнал важнее кода выхода', () => {
    const spec = resumeDialog(
      session({
        history: [{ status: 'exited', at: '2026-09-02T14:02:00.000Z', exitCode: 0, signal: 9 }],
      }),
      'claude --resume 7fa0e1ee-cc7b',
      g,
    );
    expect(spec.info[1]).toContain('сигнал 9');
  });

  it('у завершённой сессии резюме помечено как перезаписываемое', () => {
    const spec = resumeDialog(
      session({ status: 'done', summary: 'План готов: 5 шагов', summarySource: 'agent' }),
      'claude --resume 7fa0e1ee-cc7b',
      g,
    );
    expect(spec.title).toContain(g.done);
    expect(spec.info[2]).toContain('План готов');
    expect(spec.info[2]).toContain('будет перезаписано');
  });
});

describe('команда возобновления в оверлее', () => {
  it('обрывается на id сессии: длинных аргументов в макете нет', () => {
    const preview = resumePreview(
      'claude',
      ['--resume', '7fa0e1ee-cc7b', '--mcp-config', '/tmp/mcp.json'],
      '7fa0e1ee-cc7b',
    );
    expect(preview).toBe('claude --resume 7fa0e1ee-cc7b');
  });

  it('без id у провайдера честно говорит, что процесс будет новым', () => {
    expect(resumePreview('claude', ['-c', 'x', 'бриф'], null)).toContain('новый процесс по брифу');
  });
});

describe('оверлей дозаказа резюме (макет 4.7)', () => {
  it('объясняет, чем считается и как запишется, и ничего не спрашивает', () => {
    const spec = summaryDialog(session(), g);
    expect(spec.title).toBe(`резюме для ${g.exited} бэкенд`);
    expect(spec.info.join(' ')).toContain('claude -p');
    expect(spec.info.join(' ')).toContain('авто');
    expect(spec.quote).toEqual([]);
    expect(spec.footer).toContain('Enter — заказать');
    // Строки помещаются в тело рамки 48 (§4.0).
    for (const info of spec.info) expect(info.length).toBeLessThanOrEqual(BODY);
  });
});

describe('подтверждения (макеты 4.8 и 4.9)', () => {
  it('закрытие сессии называет сигнал, pid и судьбу транскрипта', () => {
    const spec = closeSessionDialog(session({ status: 'active', pid: 48213 }), g);
    expect(spec.title).toBe(`закрыть ${g.active} бэкенд`);
    expect(spec.info[0]).toBe('процессу будет послан SIGHUP · pid 48213');
    expect(spec.info[1]).toContain('транскрипт');
    expect(spec.footer).toBe('Enter — закрыть · Esc');
  });

  it('без pid строка о процессе не врёт про несуществующий номер', () => {
    const spec = closeSessionDialog(session({ status: 'active', pid: null }), g);
    expect(spec.info[0]).toBe('процессу будет послан SIGHUP');
  });

  it('выход перечисляет живые сессии', () => {
    const spec = exitDialog(['план', 'бэкенд']);
    expect(spec.title).toBe('выход');
    expect(spec.info[0]).toBe('живые сессии: план, бэкенд');
    expect(spec.info[1]).toContain('завершены');
    expect(spec.footer).toContain('Enter — выйти');
  });
});

describe('удаление работы (макеты 4.12 и 4.13)', () => {
  it('называет работу, число сессий и что уходит с диска', () => {
    const spec = deleteWorkDialog('w-0002', 'Авторизация', 3, g, BODY);

    expect(spec.title).toBe('удалить работу w-0002 · Авторизация');
    expect(spec.info[0]).toBe('3 сессии, карта, брифы, журналы и артефакты');
    expect(spec.info[1]).toBe('будут удалены; транскрипты ~/.claude останутся');
    expect(spec.info[2]).toBe('запись уйдёт из глобального индекса');
    expect(spec.footer).toBe('Enter — удалить · Esc');
    for (const info of spec.info) expect(info.length).toBeLessThanOrEqual(BODY);
  });

  it('длинный заголовок режется по ширине рамки, одна сессия склоняется', () => {
    const spec = deleteWorkDialog(
      'w-0002',
      'Очень длинный заголовок работы про всё на свете',
      1,
      g,
      BODY,
    );

    expect(spec.title.length).toBeLessThanOrEqual(BODY);
    expect(spec.title).toContain(g.ellipsis);
    expect(spec.info[0]).toBe('1 сессия, карта, брифы, журналы и артефакты');
  });

  it('живая сессия не у харнесса не даёт удалить работу', () => {
    const spec = deleteWorkBlockedDialog('w-0002', session({ status: 'active' }), g, BODY);

    expect(spec.title).toBe('удалить работу w-0002');
    expect(spec.info[0]).toContain('«бэкенд» жива');
    expect(spec.info[0]).toContain('не у харнесса');
    expect(spec.info[1]).toContain('закройте её там, где она запущена');
    expect(spec.footer).toBe('Esc — понятно');
  });
});

describe('удаление сессии (макеты 4.10 и 4.11)', () => {
  it('называет, что удаляется, что остаётся и куда денутся дети', () => {
    const spec = deleteSessionDialog(session(), ['ревью', 'тесты'], g, BODY);

    expect(spec.title).toBe(`удалить ${g.exited} бэкенд`);
    expect(spec.info[0]).toBe('запись, бриф и журнал событий будут удалены');
    expect(spec.info[1]).toBe('транскрипт в ~/.claude останется');
    expect(spec.info[2]).toBe('дочерние: ревью, тесты → поднимутся на уровень');
    expect(spec.quote).toEqual([]);
    expect(spec.footer).toBe('Enter — удалить · Esc');
    for (const info of spec.info) expect(info.length).toBeLessThanOrEqual(BODY);
  });

  it('без детей строки про них нет, а длинный список режется по ширине рамки', () => {
    expect(deleteSessionDialog(session(), [], g, BODY).info).toHaveLength(2);

    const many = deleteSessionDialog(
      session(),
      ['ревью', 'тесты', 'бэкенд', 'фронтенд', 'документация'],
      g,
      BODY,
    );
    expect(many.info[2]?.length).toBeLessThanOrEqual(BODY);
    expect(many.info[2]).toContain(g.ellipsis);
  });

  it('живую вне харнесса сессию не удаляет, а объясняет почему', () => {
    const spec = deleteBlockedDialog(session({ status: 'active', pid: null }), g, BODY);

    expect(spec.title).toBe(`удалить ${g.active} бэкенд`);
    expect(spec.info[0]).toContain('жива');
    expect(spec.info[1]).toContain('закройте её там, где она запущена');
    // Подтверждать нечего: у отказа только выход.
    expect(spec.footer).toBe('Esc — понятно');
    expect(spec.footer).not.toContain('Enter');
  });

  it('строка с pid помещается в рамку и сохраняет сам pid', () => {
    const spec = deleteBlockedDialog(session({ status: 'active', pid: 48213 }), g, BODY);

    expect(spec.info[0]?.length).toBeLessThanOrEqual(BODY);
    expect(spec.info[0]).toContain('pid 48213');
    expect(spec.info[0]).toContain(g.ellipsis);
  });
});
