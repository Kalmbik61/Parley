import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S } from '../../../shared/strings.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { useHostStore } from '../../store/host.js';
import { AssistantJournal } from './AssistantJournal.js';

let bridge: FakeBridge;
const text = S.assistant.settings;

function connect(methods: string[]): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: 't', methods } as never });
}
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'create_job',
  lines: ['Create job'],
  decidedAt: 1_700_000_000_000,
  via: 'island',
  outcome: 'done',
  ...over,
});

beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
});
afterEach(() => cleanup());

describe('AssistantJournal', () => {
  it('не зовёт метод, когда его нет в hello.methods', () => {
    connect(['providers.list']);
    render(<AssistantJournal />);
    expect(bridge.calls.some((call) => call.method === 'assistant.journal')).toBe(false);
    expect(screen.queryByTestId('assistant-journal')).toBeNull();
  });

  it('30 строк, пометка auto у автоматических', async () => {
    connect(['assistant.journal']);
    const items = Array.from({ length: 30 }, (_, i) => item(`j${i}`, i === 0 ? { via: 'auto' } : {}));
    bridge.setHandler('assistant.journal', () => ({ items }));
    render(<AssistantJournal />);
    await waitFor(() => expect(screen.getAllByTestId('assistant-journal-row').length).toBe(30));
    expect(screen.getAllByText(text.journalAuto).length).toBe(1);
    expect(bridge.calls.find((call) => call.method === 'assistant.journal')?.params).toEqual({ limit: 30 });
  });

  it('пустой список — одна строка', async () => {
    connect(['assistant.journal']);
    bridge.setHandler('assistant.journal', () => ({ items: [] }));
    render(<AssistantJournal />);
    expect(await screen.findByText(text.journalEmpty)).toBeTruthy();
  });

  it('длинные значения обрезаются, а не растягивают строку', async () => {
    connect(['assistant.journal']);
    const long = 'x'.repeat(300);
    bridge.setHandler('assistant.journal', () => ({ items: [item('a', { lines: [long, long] })] }));
    render(<AssistantJournal />);
    const row = await screen.findByTestId('assistant-journal-row');
    expect(row.className).toContain('min-w-0');
    const line = screen.getAllByText(long)[0] as HTMLElement;
    expect(line.className).toContain('truncate');
    expect(line.getAttribute('title')).toBe(long);
  });
});
