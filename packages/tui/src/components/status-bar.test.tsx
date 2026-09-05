import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { applyGlyphsConfig } from '../glyphs.js';
import { StatusBar } from './status-bar.js';

const frameOf = (node: Parameters<typeof render>[0]): string => render(node).lastFrame() ?? '';

pinUnicodeGlyphs();

describe('StatusBar', () => {
  it('показывает событие, подсказку и постоянный хвост', () => {
    const frame = frameOf(
      <StatusBar
        count={1}
        event={{ text: 'ревью ждёт ответа', hint: 'не подключена' }}
        width={80}
        prefix="ctrl+q"
      />,
    );

    expect(frame).toContain('⚑');
    expect(frame).toContain('ревью ждёт ответа');
    expect(frame).toContain('не подключена');
    expect(frame).toContain('ctrl+q ?');
  });

  it('строка события начинается с пробела, как в макете (§3)', () => {
    const frame = frameOf(
      <StatusBar count={1} event={{ text: 'ревью ждёт ответа' }} width={60} prefix="ctrl+q" />,
    );

    expect(frame.split('\n')[0]?.startsWith(' \u2691 ревью')).toBe(true);
  });

  it('счётчик появляется со второго непросмотренного события', () => {
    const single = frameOf(
      <StatusBar count={1} event={{ text: 'событие' }} width={60} prefix="ctrl+q" />,
    );
    expect(single).toContain('⚑ событие');

    const many = frameOf(
      <StatusBar count={3} event={{ text: 'событие' }} width={60} prefix="ctrl+q" />,
    );
    expect(many).toContain('⚑3 событие');
  });

  it('без событий остаётся только подсказка префикса', () => {
    const frame = frameOf(<StatusBar count={0} event={null} width={60} prefix="ctrl+q" />);
    expect(frame).not.toContain('⚑');
    expect(frame.trim()).toBe('ctrl+q ?');
  });

  it('ожидание второй клавиши показывает действия, `? все` не отбрасывается (§3)', () => {
    const wide = frameOf(<StatusBar count={0} event={null} width={120} prefix="ctrl+q" awaiting />);
    expect(wide).toContain('ctrl+q …');
    expect(wide).toContain('c новая');
    expect(wide).toContain('r возобновить');
    expect(wide).toContain('? все');
    // Справа во время ожидания ничего нет: подсказка занимает всю строку.
    expect(wide).not.toContain('ctrl+q ?');

    const narrow = frameOf(
      <StatusBar count={0} event={null} width={44} prefix="ctrl+q" awaiting />,
    );
    expect(narrow.split('\n')[0]?.length).toBeLessThanOrEqual(44);
    expect(narrow).toContain('? все');
    expect(narrow).not.toContain('r возобновить');
  });

  it('занимает одну строку и не вылезает за ширину', () => {
    const frame = frameOf(
      <StatusBar
        count={9}
        event={{ text: 'очень длинное сообщение о том, что случилось', hint: 'и подсказка' }}
        width={40}
        prefix="ctrl+q"
      />,
    );
    const lines = frame.split('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThanOrEqual(40);
    expect(frame).toContain('ctrl+q ?');
    expect(frame).toContain('…');
  });

  it('ascii из настроек заменяет флажок', () => {
    applyGlyphsConfig(true);
    const frame = frameOf(
      <StatusBar count={1} event={{ text: 'событие' }} width={60} prefix="ctrl+q" />,
    );
    expect(frame).not.toContain('⚑');
    expect(frame).toContain('! событие');
  });
});
