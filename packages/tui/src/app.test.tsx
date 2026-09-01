import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from './app.js';

describe('App', () => {
  it('рисует три панели', () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SESSIONS');
    expect(frame).toContain('SUBSESSIONS');
    expect(frame).toContain('TERMINAL');
  });

  it('в v0 правая панель — плейсхолдер', () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame()).toContain('v1');
  });
});
