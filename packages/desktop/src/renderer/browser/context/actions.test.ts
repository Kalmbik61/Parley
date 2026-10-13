// packages/desktop/src/renderer/browser/context/actions.test.ts
import { describe, expect, it, vi } from 'vitest';
import { REDACTED } from '../../../shared/redact.js';
import { consoleEntry, networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { EMPTY_DEVTOOLS, type TabDevtools } from '../devtools/store.js';
import { createPageContextActions, elementDraft, pageErrors } from './actions.js';
import type { ContextDraft } from './deliver.js';

const BOOM = consoleEntry(1, { epoch: 2, level: 'error', text: 'boom from e2e' });
const REQUEST = networkEntry('r1', {
  epoch: 2,
  method: 'POST',
  url: 'http://localhost:5173/api/settings?token=t',
  status: 500,
  statusText: 'Internal Server Error',
});

function setup(tab: TabDevtools = EMPTY_DEVTOOLS) {
  const bridge = createFakeBridge();
  bridge.setResponseBody({ text: '{"session":"s-1"}', base64: false, truncated: false });
  const drafts: ContextDraft[] = [];
  const actions = createPageContextActions({
    bridge,
    webContentsId: () => 7,
    pageUrl: () => 'http://localhost:5173/settings',
    devtools: () => tab,
    add: async (draft) => {
      drafts.push(draft);
      return 'chat';
    },
  });
  return { bridge, actions, drafts };
}

describe('createPageContextActions (спека браузера 4.3, 4.4)', () => {
  it('console — файл console без снимка', async () => {
    const { actions, drafts } = setup();
    actions.console(BOOM);
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toMatchObject({ kind: 'console', label: 'error-boom-from-e2e', imagePath: null, count: 1 });
    expect(drafts[0]?.markdown).toContain('boom from e2e');
  });

  it('request — тело ответа читается в момент клика, секреты — <redacted>; без ответа тело не читается', async () => {
    const { bridge, actions, drafts } = setup();
    actions.request(REQUEST);
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(bridge.browserCalls).toContainEqual({ method: 'responseBody', args: [7, 'r1'] });
    expect(drafts[0]?.markdown).toContain(`"session": "${REDACTED}"`);
    expect(drafts[0]?.markdown).toContain(`?token=${REDACTED}`);
    actions.request({ ...REQUEST, id: 'r2', status: null, statusText: '', failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } });
    await vi.waitFor(() => expect(drafts).toHaveLength(2));
    expect(bridge.browserCalls.filter((call) => call.method === 'responseBody')).toHaveLength(1);
  });

  it('errors — ошибки консоли и упавшие запросы одним файлом errors', async () => {
    const { actions, drafts } = setup({ ...EMPTY_DEVTOOLS, epoch: 2, console: [BOOM], network: [REQUEST] });
    actions.errors();
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toMatchObject({ kind: 'errors', label: 'settings', imagePath: null, count: 1 });
    expect(drafts[0]?.markdown).toContain('Console error: boom from e2e');
    expect(drafts[0]?.markdown).toContain('/api/settings');
  });

  it('errors без ошибок — ничего', () => {
    const { actions, drafts } = setup({ ...EMPTY_DEVTOOLS, console: [consoleEntry(1, { level: 'warning' })] });
    actions.errors();
    // errors() решает синхронно: файла нет — add не зовётся вовсе.
    expect(drafts).toEqual([]);
  });
});

describe('pageErrors (спека браузера 4.3)', () => {
  const TAB: TabDevtools = {
    ...EMPTY_DEVTOOLS,
    epoch: 3,
    console: [
      consoleEntry(1, { epoch: 3, level: 'error', text: 'boom' }),
      consoleEntry(2, { epoch: 3, level: 'error', origin: 'exception', text: 'Uncaught Error: x' }),
      consoleEntry(3, { epoch: 3, level: 'error', origin: 'network', text: 'Failed to load resource' }),
      consoleEntry(4, { epoch: 3, level: 'warning', text: 'careful' }),
      consoleEntry(5, { epoch: 1, level: 'error', text: 'old' }),
    ],
    network: [
      networkEntry('now', { epoch: 3, status: 404, statusText: 'Not Found' }),
      networkEntry('ok', { epoch: 3 }),
      networkEntry('canceled', { epoch: 3, status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }),
      networkEntry('old', { epoch: 1, status: 500 }),
    ],
    // Фильтры панели «Add errors to chat» не сужают.
    levels: { error: false, warning: true, info: true, debug: false },
    consoleText: 'zzz',
  };

  it('текущая эпоха: ошибки и исключения без строк сети, упавшие запросы без отмены; фильтры панели не действуют', () => {
    const errors = pageErrors(TAB);
    expect(errors.console.map((entry) => entry.text)).toEqual(['boom', 'Uncaught Error: x']);
    expect(errors.requests.map((entry) => entry.id)).toEqual(['now']);
  });

  it('с «Preserve log» — и прежние эпохи', () => {
    const errors = pageErrors({ ...TAB, preserve: true });
    expect(errors.console.map((entry) => entry.text)).toEqual(['boom', 'Uncaught Error: x', 'old']);
    expect(errors.requests.map((entry) => entry.id)).toEqual(['now', 'old']);
  });
});

describe('elementDraft', () => {
  it('файл element со снимком выбора и пометкой размера', () => {
    const draft = elementDraft(
      { url: 'http://x/', selector: 'button.save', text: 'Save', html: '<button>', styles: {}, imagePath: '/h/drops/a.png', viewport: { width: 375, height: 812, dpr: 2 } },
      'Mobile M, emulated',
    );
    expect(draft).toMatchObject({ kind: 'element', label: 'button.save', imagePath: '/h/drops/a.png', count: 1 });
    expect(draft.markdown).toContain('Viewport: 375×812 @2x (Mobile M, emulated)');
  });
});
