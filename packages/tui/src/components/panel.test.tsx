import type { WorkEntry, WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { cardFor, Panel, type CardProps } from './panel.js';

pinUnicodeGlyphs();

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-04',
    provider: 'claude',
    label: 'бэкенд',
    task: 'шаги 1–3',
    parent: null,
    contextFrom: [],
    status: 'pending',
    history: [{ status: 'pending', at: '2026-09-05T09:12:00.000Z' }],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

const entry = (sessions: WorkSession[]): WorkEntry => ({
  projectPath: '/dev/shop',
  map: {
    schemaVersion: 1,
    work: {
      id: 'w-0042',
      title: 'Авторизация',
      goal: '',
      status: 'active',
      createdAt: '2026-09-05T09:00:00.000Z',
      updatedAt: '2026-09-05T09:00:00.000Z',
    },
    sessions,
    messages: [],
  },
});

const card = (over: Partial<CardProps> = {}): CardProps => ({
  session: session(),
  state: 'pending',
  parent: null,
  brief: null,
  prefix: 'ctrl+q',
  atHarness: false,
  ...over,
});

const frameOf = (props: Partial<CardProps>): string =>
  render(<Panel screen={undefined} card={card(props)} width={61} height={22} />).lastFrame() ?? '';

describe('карточка панели (макеты §2)', () => {
  it('сессий нет — карточка объясняет, с чего начать', () => {
    const frame = frameOf({ session: null, state: 'idle' });
    expect(frame).toContain('сессий нет');
    expect(frame).toContain('ctrl+q c — новая сессия');
    // Панель 61: подсказка о возобновлении не влезает целиком и режется (§2, §7).
    expect(frame).toContain('ctrl+q g — возобновить');
    expect(frame).toContain('…');
  });

  it('pending показывает родителя и путь брифа, но не сам бриф (решение №12)', () => {
    const parent = session({ id: 's-02', label: 'бэкенд' });
    const child = session({ id: 's-04', label: 'тесты', parent: 's-02' });
    const props = cardFor(entry([parent, child]), child, 'pending', 'ctrl+q', false);
    const frame = frameOf(props);

    expect(frame).toContain('◌ тесты · pending');
    expect(frame).toContain('создана сессией «бэкенд»');
    expect(frame).toContain('.harnas/works/w-0042/briefs/s-04.md');
    expect(frame).toContain('старт: по брифу');
    expect(frame).toContain('Enter — запустить');
  });

  it('pending без задачи обещает тихий старт: агент ждёт запроса (план B)', () => {
    const child = session({ id: 's-04', label: 'тесты', task: '' });
    const frame = frameOf(cardFor(entry([child]), child, 'pending', 'ctrl+q', false));

    expect(frame).toContain('старт: ждёт ваш запрос');
    expect(frame).not.toContain('старт: по брифу');
  });

  it('exited показывает код выхода и дозаказ резюме', () => {
    const exited = session({
      status: 'exited',
      history: [
        { status: 'active', at: '2026-09-05T13:00:00.000Z' },
        { status: 'exited', at: '2026-09-05T14:02:00.000Z', exitCode: 0 },
      ],
    });
    const frame = frameOf({ session: exited, state: 'exited' });

    expect(frame).toContain('○ бэкенд · exited');
    expect(frame).toContain('код 0');
    expect(frame).toContain('отчёта не было');
    expect(frame).toContain('ctrl+q R — дозаказать');
    expect(frame).toContain('Enter — возобновить');
  });

  it('done показывает резюме и артефакты', () => {
    const done = session({
      status: 'done',
      summary: 'План готов: 5 шагов',
      artifacts: [{ kind: 'plan', path: 'works/w-0042/artifacts/plan.md' }],
      history: [{ status: 'done', at: '2026-09-05T12:40:00.000Z', exitCode: 0 }],
    });
    const frame = frameOf({ session: done, state: 'done' });

    expect(frame).toContain('✓ бэкенд · done');
    // Код выхода — примета `exited`; у отчитавшейся сессии его в карточке нет.
    expect(frame).not.toContain('код');
    expect(frame).toContain('«План готов: 5 шагов»');
    expect(frame).toContain('арт: plan:');
    expect(frame).toContain('перезапишет новый report');
  });

  it('живая сессия в карточке — только та, чей PTY не у харнесса (5.4)', () => {
    const outside = session({ status: 'active', pid: 48213, launchedBy: 'cli' });
    const frame = frameOf({ session: outside, state: 'working' });

    expect(frame).toContain('● бэкенд · working · запущена вне харнесса');
    expect(frame).toContain('pid 48213');
    expect(frame).toContain('подключение невозможно');
    expect(frame).toContain('ctrl+q i — детали');
  });

  it('живая сессия харнесса, отпущенная панелью, зовёт подключиться, а не врёт (2.2)', () => {
    const ours = session({ status: 'active', pid: 48213, launchedBy: 'tui' });
    const frame = frameOf({ session: ours, state: 'working', atHarness: true });

    expect(frame).toContain('● бэкенд · working');
    expect(frame).not.toContain('вне харнесса');
    expect(frame).toContain('pid 48213 · запущена харнессом');
    expect(frame).toContain('ctrl+q s → Enter — подключить');
  });
});
