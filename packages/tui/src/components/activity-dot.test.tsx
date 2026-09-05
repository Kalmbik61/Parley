import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { glyphs } from '../glyphs.js';
import type { TerminalSnapshot } from '../pty/terminal-buffer.js';
import { ActivityDot, blinkTicking, dotState, maxDotState, useBlink } from './activity-dot.js';
import { TerminalView } from './terminal-view.js';

pinUnicodeGlyphs();

const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('ActivityDot', () => {
  it('глиф и цвет по таблице макетов §6', () => {
    const g = glyphs();
    const drawn: Array<{ unmount: () => void }> = [];
    const frame = (state: Parameters<typeof ActivityDot>[0]['state']): string => {
      const app = render(<ActivityDot state={state} g={g} />);
      drawn.push(app);
      return app.lastFrame() ?? '';
    };

    expect(frame('working')).toBe('●');
    expect(frame('blocked')).toBe('●');
    expect(frame('unseen')).toBe('●');
    expect(frame('idle')).toBe('●');
    expect(frame('pending')).toBe('◌');
    expect(frame('exited')).toBe('○');
    expect(frame('done')).toBe('✓');
    expect(frame('failed')).toBe('✗');

    // Точка working подписана на общий тикер — оставленная жить, она мешала бы
    // следующим тестам.
    for (const app of drawn) app.unmount();
  });

  it('состояние точки: у живой сессии — activity, у остальных — жизненный цикл (4.1)', () => {
    expect(dotState('active', 'blocked')).toBe('blocked');
    expect(dotState('active', null)).toBe('idle');
    expect(dotState('exited', 'working')).toBe('exited');
    expect(dotState('pending', null)).toBe('pending');
  });

  // Чек-лист 24: точка работы — максимум по сессиям.
  it('максимум по сессиям: blocked > working > unseen > остальное', () => {
    expect(maxDotState(['idle', 'working', 'blocked', 'unseen'])).toBe('blocked');
    expect(maxDotState(['exited', 'unseen', 'working'])).toBe('working');
    expect(maxDotState(['done', 'unseen', 'idle'])).toBe('unseen');
    expect(maxDotState(['done', 'exited'])).toBe('exited');
    expect(maxDotState([])).toBeNull();
  });

  // Чек-лист 25, первая половина: тикер живёт только при working.
  it('тикер запускается только на working и умирает вместе с последней точкой', async () => {
    expect(blinkTicking()).toBe(false);

    const quiet = render(<ActivityDot state="idle" g={glyphs()} />);
    await settle();
    expect(blinkTicking()).toBe(false);
    quiet.unmount();

    const live = render(<ActivityDot state="working" g={glyphs()} />);
    await settle();
    expect(blinkTicking()).toBe(true);

    live.unmount();
    await settle();
    expect(blinkTicking()).toBe(false);
  });

  it('working мигает ●↔○ синхронно у всех точек', async () => {
    const two = render(
      <Box>
        <ActivityDot state="working" g={glyphs()} />
        <ActivityDot state="working" g={glyphs()} />
      </Box>,
    );
    await settle();
    expect(two.lastFrame()).toBe('●●');

    await settle(600);
    expect(two.lastFrame()).toBe('○○');

    await settle(500);
    expect(two.lastFrame()).toBe('●●');
    two.unmount();
    await settle();
  });

  it('в запасном наборе мигание — *↔o', async () => {
    process.env['HARNAS_ASCII'] = '1';
    const dot = render(<ActivityDot state="working" g={glyphs()} />);
    await settle();
    expect(dot.lastFrame()).toBe('*');

    await settle(600);
    expect(dot.lastFrame()).toBe('o');
    dot.unmount();
    await settle();
  });
});

/** Снимок PTY, который считает, сколько раз `TerminalView` его нарисовал. */
function countingSnapshot(): { snapshot: TerminalSnapshot; renders: () => number } {
  let renders = 0;
  const snapshot = {
    get lines() {
      renders += 1;
      return [[{ text: 'агент' }]];
    },
    cols: 20,
    rows: 1,
    altScreen: false,
    mouseTracking: 'none',
    bracketedPaste: false,
    cursor: { x: 0, y: 0, visible: false },
  } as unknown as TerminalSnapshot;
  return { snapshot, renders: () => renders };
}

// Чек-лист 25, вторая половина: за три секунды мигания панель не перерисовывается.
describe('мемоизация панели', () => {
  it('счётчик рендеров TerminalView не растёт за 3 секунды мигания', async () => {
    const { snapshot, renders } = countingSnapshot();

    function Harness(): ReactNode {
      // Родитель подписан на тот же тикер: без React.memo его перерисовка
      // тянула бы за собой и панель (раздел 8.2).
      const phase = useBlink(true);
      return (
        <Box flexDirection="column">
          <Text>{phase ? 'B' : 'A'}</Text>
          <TerminalView snapshot={snapshot} height={1} />
        </Box>
      );
    }

    const app = render(<Harness />);
    await settle();
    const before = renders();
    expect(before).toBeGreaterThan(0);
    expect(app.lastFrame()).toContain('A');

    // Мигание за эти три секунды было — иначе тест ничего не проверяет.
    await settle(600);
    expect(app.lastFrame()).toContain('B');
    await settle(2600);
    expect(renders()).toBe(before);

    app.unmount();
    await settle();
  }, 10_000);
});
