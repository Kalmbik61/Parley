import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from './app.js';

describe('App', () => {
  it('рисует три панели и число сессий', () => {
    const { lastFrame } = render(<App sessions={[]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SESSIONS (0)');
    expect(frame).toContain('SUBSESSIONS');
    expect(frame).toContain('TERMINAL');
  });

  it('пока ничего не открыто — правая панель подсказывает, что делать', () => {
    const { lastFrame } = render(<App sessions={[]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter на сессии');
    expect(frame).toContain('claude --resume');
  });
});
