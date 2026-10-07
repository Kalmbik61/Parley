/**
 * Тесты 2 и 3 куска 7.4 (спека 10.3): поиск в файлах — запрос через 250 мс тишины, новый ввод
 * отменяет прежний поиск и его ответ не показывается, «Showing first N matches», клик по
 * совпадению открывает вкладку файла на строке.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { FileRoot, GrepQuery, GrepResult } from '../../shared/files-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups } from '../layout/tree.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { bufferKey } from './buffer.js';
import { SEARCHING_DELAY_MS, SearchPanel } from './SearchPanel.js';
import { useFilesStore } from './store.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const KEY = '/tmp/proj\nw-01';
const ROOT: FileRoot = { workKey: KEY, spec: { kind: 'project' } };

let bridge: FakeBridge;

beforeEach(() => {
  vi.useFakeTimers();
  bridge = createFakeBridge();
  vi.mocked(toast).mockClear();
  useFilesStore.setState({ modeByWork: { [KEY]: 'search' }, focusSearch: null, reveals: {} });
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: { [KEY]: emptyLayout() },
    hydrated: { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function field(): HTMLInputElement {
  return screen.getByPlaceholderText('Search in files') as HTMLInputElement;
}

async function type(value: string): Promise<void> {
  fireEvent.change(field(), { target: { value } });
  await act(async () => {});
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function result(files: GrepResult['files'], truncated = false): GrepResult {
  return { files, truncated };
}

describe('SearchPanel (тест 2)', () => {
  it('ввод с паузой 250 мс — один grep со всеми флагами запроса', async () => {
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('f');
    await wait(100);
    await type('fo');
    await wait(100);
    await type('foo');
    await wait(249);
    expect(bridge.grepCalls).toHaveLength(0);
    await wait(1);
    expect(bridge.grepCalls).toHaveLength(1);
    expect(bridge.grepCalls[0]?.query).toEqual({ text: 'foo', caseSensitive: false, wholeWord: false, regex: false });
    expect(bridge.grepCalls[0]?.root).toEqual(ROOT);
  });

  it('«Aa», «Match whole word», «.*» уходят флагами запроса', async () => {
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    fireEvent.click(screen.getByRole('button', { name: 'Match whole word' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await type('a.b');
    await wait(250);
    expect(bridge.grepCalls.at(-1)?.query).toEqual({ text: 'a.b', caseSensitive: true, wholeWord: true, regex: true });
    expect(screen.getByRole('button', { name: 'Match case' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('второй ввод до ответа — cancel прежнего; ответ отменённого не показывается', async () => {
    const answers: Array<(value: GrepResult) => void> = [];
    const grep = vi.fn<(root: FileRoot, query: GrepQuery, signalId: string) => Promise<GrepResult>>(
      () => new Promise<GrepResult>((resolve) => answers.push(resolve)),
    );
    bridge.files.grep = grep;
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('old');
    await wait(250);
    expect(grep).toHaveBeenCalledTimes(1);
    const firstId = grep.mock.calls[0]?.[2];

    await type('new');
    expect(bridge.cancelCalls).toEqual([firstId]);
    await wait(250);
    expect(grep).toHaveBeenCalledTimes(2);
    expect(grep.mock.calls[1]?.[2]).not.toBe(firstId);

    // Отменённый поиск отвечает частью найденного — её не показываем.
    await act(async () => answers[0]?.(result([{ path: 'stale.ts', hits: [{ line: 1, column: 1, text: 'old', ranges: [[0, 3]] }] }], true)));
    expect(screen.queryByText('stale.ts')).toBeNull();
    await act(async () => answers[1]?.(result([{ path: 'fresh.ts', hits: [{ line: 2, column: 1, text: 'new', ranges: [[0, 3]] }] }])));
    expect(screen.getByText('fresh.ts')).toBeTruthy();
    expect(screen.queryByText('stale.ts')).toBeNull();
  });

  it('truncated — Showing first 2000 matches (n — число совпадений ответа)', async () => {
    const files = Array.from({ length: 200 }, (_, f) => ({
      path: `dir/f${f}.ts`,
      hits: Array.from({ length: 10 }, (_, h) => ({ line: h + 1, column: 1, text: 'needle', ranges: [[0, 6]] as [number, number][] })),
    }));
    bridge.setGrepResult(result(files, true));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('needle');
    await wait(250);
    expect(screen.getByText('Showing first 2000 matches')).toBeTruthy();
  });

  it('заголовок группы — значок файла по пути (спека значков 3.5)', async () => {
    bridge.setGrepResult(result([{ path: 'src/package.json', hits: [{ line: 1, column: 1, text: 'foo', ranges: [[0, 3]] }] }]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('foo');
    await wait(250);
    expect(screen.getByTitle('src/package.json').querySelector('img[data-file-icon]')?.getAttribute('src')).toMatch(/nodejs\.svg$/);
  });

  it('без truncated строки о пределе нет; совпадение подсвечено, длинный путь целиком в title', async () => {
    const path = `very/${'long-directory-name/'.repeat(20)}file.ts`;
    bridge.setGrepResult(result([{ path, hits: [{ line: 7, column: 7, text: 'const foo = 1', ranges: [[6, 9]] }] }]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('foo');
    await wait(250);
    expect(screen.queryByText(/Showing first/)).toBeNull();
    expect(screen.getByTitle(path)).toBeTruthy();
    const mark = document.querySelector('mark');
    expect(mark?.textContent).toBe('foo');
    expect(screen.getByTitle('const foo = 1')).toBeTruthy();
  });

  it('неверная регулярка (bad_request) — понятный текст в панели, без тоста', async () => {
    bridge.setGrepResult({ code: 'bad_request', message: 'invalid regex' });
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await type('(');
    await wait(250);
    expect(screen.getByText('Invalid regular expression')).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });

  it('неверная регулярка — ожидаемый ввод: ни console.warn, ни console.error (раунд fix-7.4, п. 4)', async () => {
    bridge.setGrepResult({ code: 'bad_request', message: 'invalid regular expression' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await type('(');
    await wait(250);
    expect(screen.getByText('Invalid regular expression')).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('прочий отказ — тост Couldn’t search in files', async () => {
    bridge.setGrepResult({ code: 'failed', message: 'git died' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('x');
    await wait(250);
    expect(toast).toHaveBeenCalledWith("Couldn't search in files: failed.");
    // Прочие сбои — по-прежнему в консоль.
    expect(warn).toHaveBeenCalledWith('[parley] files.grep', expect.anything());
    warn.mockRestore();
  });

  it('пустой запрос grep не зовёт и прежние результаты убирает', async () => {
    bridge.setGrepResult(result([{ path: 'a.ts', hits: [{ line: 1, column: 1, text: 'x', ranges: [[0, 1]] }] }]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('x');
    await wait(250);
    expect(screen.getByText('a.ts')).toBeTruthy();
    await type('');
    await wait(250);
    expect(bridge.grepCalls).toHaveLength(1);
    expect(screen.queryByText('a.ts')).toBeNull();
  });

  it('группа файла сворачивается по клику на заголовок', async () => {
    bridge.setGrepResult(result([{ path: 'a.ts', hits: [{ line: 3, column: 1, text: 'hit here', ranges: [[0, 3]] }] }]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('hit');
    await wait(250);
    expect(screen.getByTitle('hit here')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }));
    expect(screen.queryByTitle('hit here')).toBeNull();
  });

  it('openSearch просит фокус — поле получает фокус', async () => {
    useFilesStore.setState({ focusSearch: KEY });
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await act(async () => {});
    expect(document.activeElement).toBe(field());
    expect(useFilesStore.getState().focusSearch).toBeNull();
  });

  it('просьба фокуса другой работы — поле её не забирает (раунд fix-7.4, п. 1)', async () => {
    useFilesStore.setState({ focusSearch: '/tmp/proj\nw-02' });
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await act(async () => {});
    expect(document.activeElement).not.toBe(field());
    expect(useFilesStore.getState().focusSearch).toBe('/tmp/proj\nw-02');
  });
});

describe('SearchPanel — клик по совпадению (тест 3)', () => {
  it('окно длинной строки — курсор на колонку совпадения из ответа, не в начало строки (раунд fix-7.4, п. 2)', async () => {
    const text = `${'x'.repeat(497)}NEEDLE${'y'.repeat(497)}`;
    bridge.setGrepResult(result([{ path: 'min.js', hits: [{ line: 1, column: 3_000_001, text, ranges: [[497, 503]] }] }]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('NEEDLE');
    await wait(250);
    fireEvent.click(screen.getByTitle(text));
    const id = tabId.file(ROOT.spec, 'min.js');
    expect(useFilesStore.getState().reveals[bufferKey(KEY, id)]).toEqual({ line: 1, col: 3_000_001 });
  });

  it('открывает вкладку файла и ставит курсор на строку (revealAt стора)', async () => {
    bridge.setGrepResult(result([{ path: 'src/a.ts', hits: [{ line: 12, column: 7, text: 'const foo = 1', ranges: [[6, 9]] }] }]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('foo');
    await wait(250);
    fireEvent.click(screen.getByTitle('const foo = 1'));

    const id = tabId.file(ROOT.spec, 'src/a.ts');
    const layout = useLayoutStore.getState().layouts[KEY];
    expect(layout === undefined ? null : groups(layout)[0]?.activeTabId).toBe(id);
    expect(useFilesStore.getState().reveals[bufferKey(KEY, id)]).toEqual({ line: 12, col: 7 });
  });
});

// Раунд fix-7.4, п. 3: git без PCRE ищет регулярку как POSIX ERE — панель говорит об этом.
describe('SearchPanel — подсказка POSIX regex (раунд fix-7.4, п. 3)', () => {
  it('ответ с posixRegex при «.*» — подсказка видна; «.*» выключена — не видна', async () => {
    bridge.setGrepResult({ files: [], truncated: false, posixRegex: true });
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await type('\\d+');
    expect(screen.queryByText('POSIX regex')).toBeNull();
    await wait(250);
    expect(screen.getByText('POSIX regex')).toBeTruthy();
    bridge.setGrepResult(result([]));
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await wait(250);
    expect(screen.queryByText('POSIX regex')).toBeNull();
  });

  // Ревью fix-7.4, Minor 1: подсказка — о последнем ответе, а не «залипает» от прежнего (fix-lane-post, п. 5).
  it('запрос стёрт до пустого при включённой «.*» — подсказки нет', async () => {
    bridge.setGrepResult({ files: [], truncated: false, posixRegex: true });
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await type('\\d+');
    await wait(250);
    expect(screen.getByText('POSIX regex')).toBeTruthy();
    await type('');
    expect(screen.queryByText('POSIX regex')).toBeNull();
  });

  it('следующий запрос отказан (неверная регулярка или сбой) — подсказки нет', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setGrepResult({ files: [], truncated: false, posixRegex: true });
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await type('\\d+');
    await wait(250);
    expect(screen.getByText('POSIX regex')).toBeTruthy();
    bridge.setGrepResult({ code: 'bad_request', message: 'invalid regex' });
    await type('(unclosed');
    await wait(250);
    expect(screen.getByText('Invalid regular expression')).toBeTruthy();
    expect(screen.queryByText('POSIX regex')).toBeNull();

    bridge.setGrepResult({ files: [], truncated: false, posixRegex: true });
    await type('\\w+');
    await wait(250);
    expect(screen.getByText('POSIX regex')).toBeTruthy();
    bridge.setGrepResult({ code: 'failed', message: 'boom' });
    await type('\\s+');
    await wait(250);
    expect(toast).toHaveBeenCalled();
    expect(screen.queryByText('POSIX regex')).toBeNull();
  });

  it('ответ без posixRegex (git с PCRE, не-git корень) — подсказки нет', async () => {
    bridge.setGrepResult(result([]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await type('\\d+');
    await wait(250);
    expect(screen.getByText('No results')).toBeTruthy();
    expect(screen.queryByText('POSIX regex')).toBeNull();
  });
});

// Раунд fix-7.4, п. 5 (ревью 7.4-A, Minor 1 и 2): признак идущего поиска и отмена при размонтировании.
describe('SearchPanel — Searching… и размонтирование (раунд fix-7.4, п. 5)', () => {
  function pendingGrep(): { grep: ReturnType<typeof vi.fn<(root: FileRoot, query: GrepQuery, signalId: string) => Promise<GrepResult>>>; answers: Array<(value: GrepResult) => void> } {
    const answers: Array<(value: GrepResult) => void> = [];
    const grep = vi.fn<(root: FileRoot, query: GrepQuery, signalId: string) => Promise<GrepResult>>(
      () => new Promise<GrepResult>((resolve) => answers.push(resolve)),
    );
    bridge.files.grep = grep;
    return { grep, answers };
  }

  it(`Searching… — только если ответа нет дольше ${SEARCHING_DELAY_MS} мс; ответ убирает`, async () => {
    const { answers } = pendingGrep();
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('slow');
    await wait(250);
    await wait(SEARCHING_DELAY_MS - 1);
    expect(screen.queryByText('Searching…')).toBeNull();
    await wait(1);
    expect(screen.getByText('Searching…')).toBeTruthy();
    await act(async () => answers[0]?.(result([])));
    expect(screen.queryByText('Searching…')).toBeNull();
    expect(screen.getByText('No results')).toBeTruthy();
  });

  it('быстрый ответ — Searching… не мигает', async () => {
    bridge.setGrepResult(result([]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('fast');
    await wait(250);
    await wait(SEARCHING_DELAY_MS * 2);
    expect(screen.queryByText('Searching…')).toBeNull();
    expect(screen.getByText('No results')).toBeTruthy();
  });

  it('размонтирование во время поиска — cancel его id', async () => {
    const { grep } = pendingGrep();
    const view = render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('x');
    await wait(250);
    const id = grep.mock.calls[0]?.[2];
    expect(bridge.cancelCalls).toEqual([]);
    view.unmount();
    expect(bridge.cancelCalls).toEqual([id]);
  });

  it('панель другой работы вместо идущей (смена key) — cancel, поздний ответ не показан', async () => {
    const { grep, answers } = pendingGrep();
    const other: FileRoot = { workKey: '/tmp/proj w-02', spec: { kind: 'project' } };
    const error = vi.spyOn(console, 'error');
    const view = render(<SearchPanel key="a" bridge={bridge} root={ROOT} />);
    await type('x');
    await wait(250);
    const id = grep.mock.calls[0]?.[2];
    view.rerender(<SearchPanel key="b" bridge={bridge} root={other} />);
    expect(bridge.cancelCalls).toEqual([id]);
    await act(async () => answers[0]?.(result([{ path: 'late.ts', hits: [{ line: 1, column: 1, text: 'x', ranges: [[0, 1]] }] }], true)));
    expect(screen.queryByText('late.ts')).toBeNull();
    expect(field().value).toBe('');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
