import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBar } from './status-bar.js';

const frameOf = (node: Parameters<typeof render>[0]): string => render(node).lastFrame() ?? '';

afterEach(() => {
  delete process.env.HARNAS_ASCII;
});

describe('StatusBar', () => {
  it('показывает событие, подсказку и постоянный хвост', () => {
    const frame = frameOf(
      <StatusBar
        count={1}
        event={{ text: 'Cx: pending «тесты» в «Авторизация»', hint: 'Enter на ◌ — запустить' }}
        width={80}
      />,
    );

    expect(frame).toContain('⚑');
    expect(frame).toContain('Cx: pending «тесты» в «Авторизация»');
    expect(frame).toContain('Enter на ◌ — запустить');
    expect(frame).toContain('w · Ctrl+Q');
  });

  it('счётчик появляется со второго непросмотренного события', () => {
    const single = frameOf(<StatusBar count={1} event={{ text: 'событие' }} width={60} />);
    expect(single).toContain('⚑ событие');

    const many = frameOf(<StatusBar count={3} event={{ text: 'событие' }} width={60} />);
    expect(many).toContain('⚑3 событие');
  });

  it('без событий остаётся только шпаргалка', () => {
    const frame = frameOf(<StatusBar count={0} event={null} width={60} />);
    expect(frame).not.toContain('⚑');
    expect(frame.trim()).toBe('w · Ctrl+Q');
  });

  it('занимает одну строку и не вылезает за ширину', () => {
    const frame = frameOf(
      <StatusBar
        count={9}
        event={{ text: 'очень длинное сообщение о том, что случилось', hint: 'и подсказка' }}
        width={40}
      />,
    );
    const lines = frame.split('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThanOrEqual(40);
    expect(frame).toContain('w · Ctrl+Q');
    expect(frame).toContain('…');
  });

  it('HARNAS_ASCII=1 заменяет флажок', () => {
    process.env.HARNAS_ASCII = '1';
    const frame = frameOf(<StatusBar count={1} event={{ text: 'событие' }} width={60} />);
    expect(frame).not.toContain('⚑');
    expect(frame).toContain('! событие');
  });
});
