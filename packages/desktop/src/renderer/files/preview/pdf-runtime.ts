/**
 * pdf.js для превью PDF (кусок 7.5, спека 10.6) — грузится лениво, один раз на окно: окно без
 * открытых PDF его не тянет. Всё локально, CDN нет:
 * - воркер — модулем `?worker` electron-vite, как у Monaco (`monaco-setup.ts`): CSP
 *   `worker-src 'self'` его пускает и на `file://` собранного окна;
 * - `cmaps/` и `standard_fonts/` — каталоги сборки рендерера (`electron.vite.config.ts`).
 *
 * `pdf_viewer.mjs` (прокрутка страниц, слой текста и ссылок, поиск) берёт pdf.js из
 * `globalThis.pdfjsLib` в момент своей загрузки — поэтому он грузится вторым, после присвоения.
 * Тесты подменяют этот модуль целиком: в jsdom нет ни canvas, ни `DOMMatrix`.
 */

import type * as Pdfjs from 'pdfjs-dist';
import type * as PdfViewer from 'pdfjs-dist/web/pdf_viewer.mjs';

export interface PdfRuntime {
  pdfjs: Pick<typeof Pdfjs, 'getDocument' | 'VerbosityLevel' | 'AnnotationMode'>;
  viewer: Pick<typeof PdfViewer, 'EventBus' | 'PDFLinkService' | 'PDFFindController' | 'PDFViewer'>;
}

let loading: Promise<PdfRuntime> | null = null;

async function load(): Promise<PdfRuntime> {
  const [pdfjs, { default: PdfWorker }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?worker'),
    import('pdfjs-dist/web/pdf_viewer.css'),
  ]);
  // Один воркер на окно: документы превью открываются и закрываются, а разбор идёт в нём же.
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;
  const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
  return { pdfjs, viewer };
}

export function loadPdfRuntime(): Promise<PdfRuntime> {
  // Отказ не запоминается: следующий PDF попробует загрузить чанк заново.
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

