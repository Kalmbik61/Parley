/**
 * Превью PDF (кусок 7.5, спека 10.6, 15.2): `PDFViewer` pdf.js с прокруткой страниц, слоем текста
 * и слоем ссылок, поиск ⌘F по тексту страниц.
 *
 * Безопасность — файл пишет агент, PDF может быть враждебным:
 * - данные — байты `files.readBytes` (`getDocument({ data })`), не URL: проверка корней действует и
 *   здесь, `file://` в рендерере нет;
 * - `isEvalSupported: false` — закрытие CVE-2024-4367 для pdf.js до 4.2.67; в pdf.js 6 eval нет
 *   вовсе, CSP его и так запрещает — это страховка на случай отката версии;
 * - `enableScripting: false` и без `pdf.sandbox`: скрипты PDF не исполняются;
 * - `useWasm: false`: без WebAssembly CSP не ослабляется (`'wasm-unsafe-eval'`) — ценой картинок
 *   JPX и JBIG2 и цветовых профилей ICC, их pdf.js тогда пропускает;
 * - ссылки аннотаций — свой `linkService`: без `href` (переход окна невозможен), клик открывает
 *   только `http(s)` и только через `openPreviewUrl`; прочие схемы — ничего;
 * - `cMapUrl` и `standardFontDataUrl` — каталоги сборки; воркер их сам не тянет
 *   (`useWorkerFetch: false`): его `fetch` не умеет `file://`, окно читает их за него.
 *
 * ⌘F — свой обработчик: у `find` реестра `when: 'terminal'` (6.1a), обработчик окна ⌘F в превью
 * пропускает, а пункт меню «Find» знает только терминалы. Корень фокусируемый; `preventDefault`
 * не отдаёт сочетание пункту меню.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { errorText, S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { openPreviewUrl, isWebUrl } from './open-external.js';
import { loadPdfRuntime, type PdfRuntime } from './pdf-runtime.js';

type Viewer = InstanceType<PdfRuntime['viewer']['PDFViewer']>;
type ViewerOptions = ConstructorParameters<PdfRuntime['viewer']['PDFViewer']>[0];
type EventBus = InstanceType<PdfRuntime['viewer']['EventBus']>;

/** Адрес каталога pdf.js в сборке рендерера — рядом с `index.html` (`electron.vite.config.ts`). */
function assetDirUrl(dir: 'cmaps' | 'standard_fonts'): string {
  return new URL(`pdfjs/${dir}/`, document.baseURI).href;
}

/**
 * Локализация pdf.js без его словарей: иначе `PDFViewer` заводит `GenericL10n`, а тот тянет
 * файлы `.ftl` по сети и пишет в страницы свои подписи. Окно — только английское из `strings.ts`.
 */
const SILENT_L10N = {
  getLanguage: () => 'en-us',
  getDirection: () => 'ltr',
  get: async (_ids: unknown, _args: unknown, fallback?: string) => fallback ?? '',
  translate: async () => undefined,
  translateOnce: async () => undefined,
  destroy: async () => undefined,
  pause: () => undefined,
  resume: () => undefined,
} as unknown as NonNullable<ViewerOptions['l10n']>;

/** `linkService` превью: внутренние переходы — как у pdf.js, внешние — только через окно. */
function createLinkService(runtime: PdfRuntime, eventBus: EventBus, openUrl: (url: string) => void): InstanceType<PdfRuntime['viewer']['PDFLinkService']> {
  class PreviewLinkService extends runtime.viewer.PDFLinkService {
    override addLinkAttributes(link: HTMLAnchorElement, url: string): void {
      // Без `href`: ни клик, ни средняя кнопка, ни перетаскивание не уведут окно по адресу из PDF.
      link.removeAttribute('href');
      link.style.cursor = 'pointer';
      if (isWebUrl(url)) link.title = url;
      link.onclick = (event) => {
        event.preventDefault();
        if (isWebUrl(url)) openUrl(url);
        return false;
      };
    }
  }
  return new PreviewLinkService({ eventBus });
}

export interface PdfPreviewProps {
  bridge: HarnasBridge;
  bytes: Uint8Array;
}

export function PdfPreview({ bridge, bytes }: PdfPreviewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busRef = useRef<EventBus | null>(null);
  const [failed, setFailed] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let disposed = false;
    let destroy: (() => Promise<void>) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    setFailed(false);
    loadPdfRuntime()
      .then(async (runtime) => {
        const container = containerRef.current;
        const inner = viewerRef.current;
        if (disposed || container === null || inner === null) return;
        const eventBus = new runtime.viewer.EventBus();
        const linkService = createLinkService(runtime, eventBus, (url) => openPreviewUrl(bridge, url));
        const findController = new runtime.viewer.PDFFindController({ eventBus, linkService });
        const viewer: Viewer = new runtime.viewer.PDFViewer({
          container,
          viewer: inner,
          eventBus,
          linkService,
          findController,
          l10n: SILENT_L10N,
          // Без форм: поля формы PDF — это уже ввод, а превью только показывает.
          annotationMode: runtime.pdfjs.AnnotationMode.ENABLE,
        });
        linkService.setViewer(viewer);
        eventBus.on('pagesinit', () => {
          viewer.currentScaleValue = 'page-width';
        });
        // Ширина страниц следует за шириной тела: сплит группы и ресайз сайдбара.
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (viewer.pdfDocument) viewer.currentScaleValue = 'page-width';
          });
          resizeObserver.observe(container);
        }
        busRef.current = eventBus;
        const params = {
          // Копия: pdf.js передаёт буфер воркеру, и байты тела после этого стали бы пустыми.
          data: bytes.slice(),
          isEvalSupported: false,
          enableScripting: false,
          enableXfa: false,
          useWasm: false,
          useWorkerFetch: false,
          cMapUrl: assetDirUrl('cmaps'),
          cMapPacked: true,
          standardFontDataUrl: assetDirUrl('standard_fonts'),
          verbosity: runtime.pdfjs.VerbosityLevel.ERRORS,
        };
        const task = runtime.pdfjs.getDocument(params);
        destroy = () => task.destroy();
        const document = await task.promise;
        if (disposed) return;
        viewer.setDocument(document);
        linkService.setDocument(document, null);
      })
      .catch((error: unknown) => {
        console.warn('[harnas] pdf preview', error);
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      busRef.current = null;
      resizeObserver?.disconnect();
      destroy?.().catch((error: unknown) => console.warn('[harnas] pdf destroy', error));
    };
  }, [bridge, bytes]);

  const find = useCallback(
    (text: string, again: boolean, previous: boolean) => {
      busRef.current?.dispatch('find', {
        source: null,
        type: again ? 'again' : '',
        query: text,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: previous,
        matchDiacritics: false,
      });
    },
    [],
  );

  const closeFind = (): void => {
    setFinding(false);
    busRef.current?.dispatch('findbarclose', { source: null });
    rootRef.current?.focus();
  };

  useEffect(() => {
    if (finding) inputRef.current?.focus();
  }, [finding]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const isF = event.key.toLowerCase() === 'f' || event.code === 'KeyF';
    if (!isF || !event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (finding) inputRef.current?.select();
    setFinding(true);
  };

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        <p className="max-w-full break-words">{errorText('failed', S.errors.actions.openFile)}</p>
      </div>
    );
  }

  return (
    <div ref={rootRef} data-testid="pdf-preview" tabIndex={0} onKeyDown={onKeyDown} className="relative h-full min-h-0 min-w-0 outline-none">
      {/* `PDFViewer` требует абсолютно спозиционированный контейнер с прокруткой. */}
      <div ref={containerRef} className="absolute inset-0 overflow-auto bg-muted">
        <div ref={viewerRef} className="pdfViewer" />
      </div>
      {finding ? (
        <div className="absolute top-2 right-4 z-20 flex max-w-[calc(100%-2rem)] items-center gap-1 rounded-md border border-border bg-background p-1 shadow-md">
          <input
            ref={inputRef}
            value={query}
            placeholder={S.terminal.findPlaceholder}
            aria-label={S.terminal.findPlaceholder}
            className="h-6 w-48 min-w-0 flex-1 rounded border border-input bg-transparent px-2 text-xs outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
              find(event.target.value, false, false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                find(query, true, event.shiftKey);
              }
            }}
          />
          <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" aria-label={S.terminal.previousMatch} title={S.terminal.previousMatch} onClick={() => find(query, true, true)}>
            <ChevronUp className="size-4" />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" aria-label={S.terminal.nextMatch} title={S.terminal.nextMatch} onClick={() => find(query, true, false)}>
            <ChevronDown className="size-4" />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" aria-label={S.common.close} title={S.common.close} onClick={closeFind}>
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
