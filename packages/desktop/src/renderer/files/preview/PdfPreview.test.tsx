/**
 * Кусок 7.5, тесты 5 и 6: PDF с подставным pdf.js (`pdf-runtime.ts`). Данные — байты
 * `files.readBytes`, не URL; eval и скрипты PDF выключены; ссылки аннотаций — только http(s) и
 * только через `app.openExternal`; ⌘F — своя полоса поиска по тексту страниц.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';

interface FakeState {
  getDocumentCalls: Array<Record<string, unknown>>;
  viewers: Array<{ options: Record<string, unknown>; document: unknown; currentScaleValue: string }>;
  dispatched: Array<{ name: string; data: Record<string, unknown> }>;
  destroyed: number;
}

const fake = vi.hoisted(() => ({ state: null as unknown as FakeState }));

vi.mock('./pdf-runtime.js', () => {
  class EventBus {
    private listeners = new Map<string, Array<(data: unknown) => void>>();
    on(name: string, listener: (data: unknown) => void): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    off(): void {}
    dispatch(name: string, data: Record<string, unknown>): void {
      fake.state.dispatched.push({ name, data });
      for (const listener of this.listeners.get(name) ?? []) listener(data);
    }
  }
  class PDFLinkService {
    externalLinkEnabled = true;
    constructor(readonly options: Record<string, unknown>) {}
    setViewer(): void {}
    setDocument(): void {}
    addLinkAttributes(link: HTMLAnchorElement, url: string): void {
      // Как у настоящего: href на адрес — то, чего превью допускать нельзя.
      link.href = url;
    }
  }
  class PDFFindController {
    constructor(readonly options: Record<string, unknown>) {}
    setDocument(): void {}
  }
  class PDFViewer {
    document: unknown = null;
    currentScaleValue = 'auto';
    constructor(readonly options: Record<string, unknown>) {
      fake.state.viewers.push(this as unknown as FakeState['viewers'][number]);
    }
    setDocument(document: unknown): void {
      this.document = document;
    }
    cleanup(): void {}
  }
  return {
    loadPdfRuntime: async () => ({
      pdfjs: {
        getDocument: (params: Record<string, unknown>) => {
          fake.state.getDocumentCalls.push(params);
          return {
            promise: Promise.resolve({ numPages: 2 }),
            destroy: async () => {
              fake.state.destroyed += 1;
            },
          };
        },
        VerbosityLevel: { ERRORS: 0 },
        AnnotationMode: { ENABLE: 1 },
      },
      viewer: { EventBus, PDFLinkService, PDFFindController, PDFViewer },
    }),
  };
});

const { PdfPreview } = await import('./PdfPreview.js');

let bridge: FakeBridge;

beforeEach(() => {
  fake.state = { getDocumentCalls: [], viewers: [], dispatched: [], destroyed: 0 };
  bridge = createFakeBridge();
});

afterEach(() => cleanup());

async function renderPdf(): Promise<ReturnType<typeof render>> {
  const result = render(<PdfPreview bridge={bridge} bytes={new Uint8Array([37, 80, 68, 70])} />);
  await waitFor(() => expect(fake.state.viewers[0]?.document).not.toBeNull());
  return result;
}

function linkServiceOf(): { addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void } {
  const service = fake.state.viewers[0]?.options.linkService;
  if (service === undefined) throw new Error('нет linkService');
  return service as { addLinkAttributes(link: HTMLAnchorElement, url: string): void };
}

describe('PdfPreview, подставной getDocument (тест 5)', () => {
  it('получил data (копию байтов), не получил url; isEvalSupported: false и enableScripting: false', async () => {
    await renderPdf();
    const params = fake.state.getDocumentCalls[0];
    expect(params?.data).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(params).not.toHaveProperty('url');
    expect(params?.isEvalSupported).toBe(false);
    expect(params?.enableScripting).toBe(false);
    // Локальные каталоги сборки, не CDN; воркер сам файлы не тянет — только через окно.
    expect(String(params?.cMapUrl)).toBe(new URL('pdfjs/cmaps/', document.baseURI).href);
    expect(String(params?.cMapUrl)).not.toMatch(/cdn|unpkg|jsdelivr/);
    expect(String(params?.standardFontDataUrl)).toMatch(/pdfjs\/standard_fonts\/$/);
    expect(params?.useWasm).toBe(false);
  });

  it('ссылка аннотации https — app.openExternal, переход окна погашен; file:///etc/passwd и javascript: — ничего', async () => {
    await renderPdf();
    const service = linkServiceOf();
    const https = document.createElement('a');
    service.addLinkAttributes(https, 'https://example.com/doc');
    expect(https.getAttribute('href')).toBeNull();
    expect(fireEvent.click(https)).toBe(false);
    expect(bridge.externalOpened).toEqual(['https://example.com/doc']);

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)']) {
      const link = document.createElement('a');
      service.addLinkAttributes(link, url);
      expect(link.getAttribute('href')).toBeNull();
      expect(fireEvent.click(link)).toBe(false);
    }
    expect(bridge.externalOpened).toEqual(['https://example.com/doc']);
  });

  it('размонтирование уничтожает документ', async () => {
    const { unmount } = await renderPdf();
    unmount();
    await waitFor(() => expect(fake.state.destroyed).toBe(1));
  });
});

describe('PdfPreview, ⌘F (тест 6)', () => {
  it('в фокусе: ⌘F — defaultPrevented, полоса поиска открыта, find pdf.js с запросом; Esc закрывает', async () => {
    await renderPdf();
    const root = screen.getByTestId('pdf-preview');
    expect(root.tabIndex).toBe(0);
    root.focus();
    expect(fireEvent.keyDown(root, { key: 'f', metaKey: true })).toBe(false);
    const input = await screen.findByPlaceholderText('Find…');
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: 'hello' } });
    const finds = (): Array<Record<string, unknown>> => fake.state.dispatched.filter((item) => item.name === 'find').map((item) => item.data);
    expect(finds().at(-1)).toMatchObject({ query: 'hello', type: '', findPrevious: false, highlightAll: true });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(finds().at(-1)).toMatchObject({ query: 'hello', type: 'again', findPrevious: false });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(finds().at(-1)).toMatchObject({ query: 'hello', type: 'again', findPrevious: true });
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(finds().at(-1)).toMatchObject({ type: 'again', findPrevious: true });
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(finds().at(-1)).toMatchObject({ type: 'again', findPrevious: false });

    act(() => void fireEvent.keyDown(input, { key: 'Escape' }));
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
    expect(fake.state.dispatched.at(-1)?.name).toBe('findbarclose');
    expect(document.activeElement).toBe(root);
  });

  it('⌘F без Meta и в другой раскладке: обычная f не перехватывается; кнопка × закрывает', async () => {
    await renderPdf();
    const root = screen.getByTestId('pdf-preview');
    expect(fireEvent.keyDown(root, { key: 'f' })).toBe(true);
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
    // Русская раскладка: key — «а», code — KeyF.
    expect(fireEvent.keyDown(root, { key: 'а', code: 'KeyF', metaKey: true })).toBe(false);
    await screen.findByPlaceholderText('Find…');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
  });
});
