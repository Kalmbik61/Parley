import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import type { NetworkEntry, ResponseBody } from '../../../shared/browser-devtools.js';
import { networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { RequestDetails } from './RequestDetails.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let bridge: FakeBridge;

const FAILED = networkEntry('r1', {
  method: 'POST',
  url: 'http://localhost:5173/api/settings?tab=general&debug=1',
  status: 500,
  statusText: 'Internal Server Error',
  mimeType: 'application/json',
  remoteAddress: '127.0.0.1:5173',
  requestHeaders: [
    ['Content-Type', 'application/json'],
    ['Authorization', 'Bearer secret-token'],
  ],
  responseHeaders: [['content-type', 'application/json']],
  hasPostData: true,
  postData: '{"theme":"dark","items":[1,2]}',
});

function renderDetails(entry: NetworkEntry = FAILED, extra: { onAddToChat?: (entry: NetworkEntry) => void } = {}): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  render(<RequestDetails entry={entry} webContentsId={7} bridge={bridge} onClose={onClose} {...extra} />);
  return { onClose };
}

async function openResponse(): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Response' }));
  });
}

beforeEach(() => {
  bridge = createFakeBridge();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(toast).mockClear();
});

describe('RequestDetails — Headers и Payload (спека 4.4)', () => {
  it('Headers: General, заголовки ответа и запроса — как есть, без маски', () => {
    renderDetails();
    const text = screen.getByTestId('request-details').textContent ?? '';
    expect(text).toContain('URL:http://localhost:5173/api/settings?tab=general&debug=1');
    expect(text).toContain('Method:POST');
    expect(text).toContain('Status:500 Internal Server Error');
    expect(text).toContain('Remote address:127.0.0.1:5173');
    expect(text).toContain('Authorization:Bearer secret-token');
  });

  it('Payload: query по параметрам, JSON-тело — отформатированным', () => {
    renderDetails();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Payload' }));
    const text = screen.getByTestId('request-details').textContent ?? '';
    expect(text).toContain('tab:general');
    expect(text).toContain('debug:1');
    expect(screen.getByTestId('request-body').textContent).toBe('{\n  "theme": "dark",\n  "items": [\n    1,\n    2\n  ]\n}');
  });

  it('Payload: form — по полям; без query и тела — No payload', () => {
    renderDetails(networkEntry('f', { requestHeaders: [['Content-Type', 'application/x-www-form-urlencoded']], postData: 'name=Ann&age=30', hasPostData: true }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Payload' }));
    expect(screen.getByTestId('request-details').textContent).toContain('name:Ann');
    expect(screen.getByTestId('request-details').textContent).toContain('age:30');
    cleanup();
    renderDetails(networkEntry('g'));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Payload' }));
    expect(screen.getByText('No payload')).toBeTruthy();
  });
});

describe('RequestDetails — Response по клику (спека 4.4)', () => {
  it('Response — responseBody(id гостя, requestId); JSON — отформатированным', async () => {
    bridge.setResponseBody({ text: '{"error":"db down"}', base64: false, truncated: false });
    renderDetails();
    await openResponse();
    expect(bridge.browserCalls).toContainEqual({ method: 'responseBody', args: [7, 'r1'] });
    expect(screen.getByTestId('response-body').textContent).toBe('{\n  "error": "db down"\n}');
  });

  it('тела нет — Body is no longer available', async () => {
    renderDetails();
    await openResponse();
    expect(screen.getByTestId('response-gone').textContent).toBe('Body is no longer available');
  });

  it('бинарное — размер и тип; обрезанное — пометка «Showing the first 1.0 MB»', async () => {
    bridge.setResponseBody({ text: 'AAAAAAAAAAAA', base64: true, truncated: false });
    renderDetails(networkEntry('img', { mimeType: 'image/png' }));
    await openResponse();
    expect(screen.getByTestId('response-body').textContent).toBe('Binary data, 9 B, image/png');
    cleanup();
    bridge.setResponseBody({ text: 'x'.repeat(10), base64: false, truncated: true });
    renderDetails(networkEntry('big', { mimeType: 'text/plain' }));
    await openResponse();
    expect(screen.getByText('Showing the first 1.0 MB')).toBeTruthy();
  });

  it('отказ моста — тост и снова Load response', async () => {
    bridge.setResponseBody({ code: 'failed', message: 'boom' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderDetails();
    await openResponse();
    expect(toast).toHaveBeenCalledWith("Couldn't load the response: failed.");
    expect(screen.getByRole('button', { name: 'Load response' })).toBeTruthy();
  });

  it('другой запрос — снова Headers, тело не загружено', async () => {
    bridge.setResponseBody({ text: 'ok', base64: false, truncated: false });
    const onClose = vi.fn();
    const { rerender } = render(<RequestDetails entry={FAILED} webContentsId={7} bridge={bridge} onClose={onClose} />);
    await openResponse();
    expect(screen.getByTestId('response-body').textContent).toBe('ok');
    rerender(<RequestDetails entry={networkEntry('r2')} webContentsId={7} bridge={bridge} onClose={onClose} />);
    expect(screen.getByRole('tab', { name: 'Headers' }).getAttribute('data-state')).toBe('active');
    expect(screen.queryByTestId('response-body')).toBeNull();
  });
});

describe('RequestDetails — тело и смена запроса (спека 4.4)', () => {
  const PENDING = networkEntry('p', { status: null, statusText: '', durationMs: null, encodedBytes: null });
  const FINISHED = { ...PENDING, status: 200, statusText: 'OK', durationMs: 40, encodedBytes: 5 };

  /** `responseBody`: первый вызов не отвечает, пока тест не вызовет `resolveFirst`; следующие сразу отвечают `later`. */
  function deferFirstAnswer(later: ResponseBody | null): { resolveFirst(body: ResponseBody | null): void } {
    let resolveFirst: (body: ResponseBody | null) => void = () => {};
    let calls = 0;
    vi.spyOn(bridge.browser, 'responseBody').mockImplementation(() => {
      calls += 1;
      if (calls > 1) return Promise.resolve(later);
      return new Promise<ResponseBody | null>((resolve) => {
        resolveFirst = resolve;
      });
    });
    return { resolveFirst: (body) => resolveFirst(body) };
  }

  it('запрос ещё идёт — «gone»; закончился — снова Load response, и тело грузится', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<RequestDetails entry={PENDING} webContentsId={7} bridge={bridge} onClose={onClose} />);
    await openResponse();
    expect(screen.getByTestId('response-gone')).toBeTruthy();
    bridge.setResponseBody({ text: 'done', base64: false, truncated: false });
    rerender(<RequestDetails entry={FINISHED} webContentsId={7} bridge={bridge} onClose={onClose} />);
    expect(screen.queryByTestId('response-gone')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Response' }).getAttribute('data-state')).toBe('active');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load response' }));
    });
    expect(screen.getByTestId('response-body').textContent).toBe('done');
  });

  it('запрос закончился, пока тело грузилось, — ответ «до конца» отброшен, Load response снова есть', async () => {
    const deferred = deferFirstAnswer(null);
    const onClose = vi.fn();
    const { rerender } = render(<RequestDetails entry={PENDING} webContentsId={7} bridge={bridge} onClose={onClose} />);
    await openResponse();
    rerender(<RequestDetails entry={FINISHED} webContentsId={7} bridge={bridge} onClose={onClose} />);
    await act(async () => {
      deferred.resolveFirst(null);
    });
    expect(screen.queryByTestId('response-gone')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load response' })).toBeTruthy();
  });

  it('поздний ответ прежнего запроса не затирает панель нового', async () => {
    const deferred = deferFirstAnswer({ text: 'B body', base64: false, truncated: false });
    const onClose = vi.fn();
    const { rerender } = render(<RequestDetails entry={FAILED} webContentsId={7} bridge={bridge} onClose={onClose} />);
    await openResponse();
    expect(screen.getByText('Loading…')).toBeTruthy();
    rerender(<RequestDetails entry={networkEntry('r2')} webContentsId={7} bridge={bridge} onClose={onClose} />);
    await act(async () => {
      deferred.resolveFirst({ text: 'A body', base64: false, truncated: false });
    });
    expect(screen.queryByTestId('response-body')).toBeNull();
    await openResponse();
    expect(screen.getByTestId('response-body').textContent).toBe('B body');
  });
});

describe('RequestDetails — действия', () => {
  it('Copy URL — адрес в буфер; закрыть — onClose; Add to chat — только с колбэком этапа B', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onAddToChat = vi.fn();
    const { onClose } = renderDetails(FAILED, { onAddToChat });
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(FAILED.url);
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(onAddToChat).toHaveBeenCalledWith(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    renderDetails();
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull();
  });
});
