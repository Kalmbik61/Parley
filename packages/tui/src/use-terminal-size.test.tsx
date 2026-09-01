import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { useTerminalSize } from './use-terminal-size.js';

function Probe(): React.ReactNode {
  const { columns, rows } = useTerminalSize();
  return <Text>{`${columns}x${rows}`}</Text>;
}

describe('useTerminalSize', () => {
  it('не-TTY stdout не должен давать undefined — иначе макет схлопывается', () => {
    const frame = render(<Probe />).lastFrame() ?? '';
    const [columns, rows] = frame.trim().split('x').map(Number);
    expect(Number.isFinite(columns)).toBe(true);
    expect(Number.isFinite(rows)).toBe(true);
    expect(rows).toBeGreaterThan(0);
  });
});
