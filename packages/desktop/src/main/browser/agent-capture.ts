/**
 * Снимок страницы для агента (спека 2026-10-07-browser-devtools-agent-design.md, 5.1, 8): размер, временная эмуляция,
 * fullPage по полосам, повтор снимка невидимой страницы, сохранение в `drops/`.
 */
import type { WebContents } from 'electron';
import { AGENT_LIMITS, AGENT_VIEWPORT } from '@parley/protocol';
import type { BrowserAgentArgs, BrowserAgentOpEvent, BrowserAgentScreenshotResult } from '@parley/protocol';
import { VIEWPORT_PRESETS, viewportSize } from '../../shared/browser-devtools.js';
import type { ViewportPreset, ViewportSpec } from '../../shared/browser-devtools.js';
import type { AgentActivity } from '../../shared/browser-types.js';
import { redactUrl } from '../../shared/redact.js';
import { AgentOpError } from './agent-errors.js';
import type { LayoutMetrics, PageRecord, PageRegistry } from './agent-pages.js';
import type { Emulation } from './emulation.js';
import type { Inspector } from './inspector.js';

/** Размер снимка агента: совпал с пресетом в любой ориентации — пресет, иначе Custom; DPR 1 — PNG в CSS-пикселях. */
export function captureSpec(width: number, height: number): ViewportSpec {
  for (const [preset, size] of Object.entries(VIEWPORT_PRESETS) as Array<[ViewportPreset, { width: number; height: number }]>) {
    if (size.width === width && size.height === height) return { preset, rotated: false, dpr: 1 };
    if (size.width === height && size.height === width) return { preset, rotated: true, dpr: 1 };
  }
  return { width, height, mobile: false, dpr: 1 };
}

/**
 * Повторы снимка невидимой страницы: до ~0,5 с, пока окно не сделает её поверхность прозрачной, но видимой. Повторяется
 * только отказ «кадр не рисуется» (Chromium: «Unable to capture screenshot»); другая ошибка уходит агенту сразу.
 */
const HIDDEN_CAPTURE_RETRIES = 10;
const NOT_DRAWN = /capture screenshot/i;
const HIDDEN_CAPTURE_RETRY_MS = 50;

export interface AgentCaptureDeps {
  inspector: Pick<Inspector, 'send'>;
  emulation: Pick<Emulation, 'current' | 'withTemporary'>;
  registry: Pick<PageRegistry, 'fresh'>;
  saveImage(png: Buffer): Promise<string | null>;
  image: { size(png: Buffer): { width: number; height: number }; resize(png: Buffer, width: number, height: number): Buffer; stitch(parts: Buffer[]): Buffer };
  activity(e: AgentActivity): void;
}

export interface AgentCapture {
  screenshotOf(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentArgs<'screenshot'>): Promise<BrowserAgentScreenshotResult>;
}

export function createAgentCapture(deps: AgentCaptureDeps): AgentCapture {
  /** Длинная сторона PNG — не больше `AGENT_LIMITS.screenshotLongSide` (предел картинки, которую модель читает целиком). */
  function fitLongSide(png: Buffer): Buffer {
    const size = deps.image.size(png);
    const long = Math.max(size.width, size.height);
    if (long <= AGENT_LIMITS.screenshotLongSide) return png;
    const scale = AGENT_LIMITS.screenshotLongSide / long;
    return deps.image.resize(png, Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
  }

  async function screenshotOf(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentArgs<'screenshot'>): Promise<BrowserAgentScreenshotResult> {
    const id = contents.id;
    const metrics = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
    const current = { width: Math.round(metrics.cssLayoutViewport.clientWidth), height: Math.round(metrics.cssLayoutViewport.clientHeight) };
    const spec = args.width === undefined && args.height === undefined ? null : captureSpec(args.width ?? current.width, args.height ?? current.height);
    const view = spec === null ? current : (({ width, height }) => ({ width, height }))(viewportSize(spec));

    const shoot = async (clip?: { x: number; y: number; width: number; height: number; scale: number }): Promise<Buffer> => {
      const params = clip === undefined ? { format: 'png' } : { format: 'png', clip, captureBeyondViewport: true };
      for (let attempt = 0; ; attempt += 1) {
        try {
          const shot = await deps.inspector.send<{ data: string }>(id, 'Page.captureScreenshot', params);
          return Buffer.from(shot.data, 'base64');
        } catch (error) {
          // Видимость читается из реестра сейчас: за время снимка человек мог показать страницу или спрятать её.
          const hidden = deps.registry.fresh(record)?.visible === false;
          if (!hidden || !NOT_DRAWN.test(error instanceof Error ? error.message : String(error))) throw error;
          if (attempt >= HIDDEN_CAPTURE_RETRIES) {
            throw new AgentOpError('tab_hidden', `Page ${record.agentId} is not shown to the human and Chromium does not draw it: ask them to open its browser panel, or read browser_console and browser_network.`);
          }
          await new Promise((resolve) => setTimeout(resolve, HIDDEN_CAPTURE_RETRY_MS));
        }
      }
    };

    const notes: string[] = [];
    const capture = async (): Promise<{ png: Buffer; viewport: { width: number; height: number } }> => {
      if (args.fullPage !== true) return { png: await shoot(), viewport: view };
      // Высота страницы — уже при нужном размере (под временной эмуляцией вёрстка другая).
      const page = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
      const total = Math.max(view.height, Math.ceil(page.cssContentSize.height));
      if (total > view.height * AGENT_LIMITS.fullPageViewports) {
        throw new AgentOpError(
          'bad_request',
          `The page is ${total} px tall, more than ${AGENT_LIMITS.fullPageViewports} viewport heights (${view.height} px): take viewport screenshots of parts of the page instead.`,
        );
      }
      const wide = Math.max(view.width, Math.ceil(page.cssContentSize.width));
      // Ширина не больше предела размера снимка: страница в десятки тысяч пикселей дала бы полосы в сотни мегабайт.
      const width = Math.min(wide, AGENT_VIEWPORT.maxWidth);
      if (width < wide) notes.push(`The page is ${wide} px wide; the screenshot is cut at ${width} px.`);
      const strips: Buffer[] = [];
      // Полоса выше поверхности вида рисуется повтором (спайк 0.7): режем по высоте вьюпорта и склеиваем.
      for (let y = 0; y < total; y += view.height) strips.push(await shoot({ x: 0, y, width, height: Math.min(view.height, total - y), scale: 1 }));
      return { png: strips.length === 1 ? (strips[0] as Buffer) : deps.image.stitch(strips), viewport: { width, height: total } };
    };

    // Невидимой странице поверхность переводят в opacity: 0 (спайк 0.2); смене размера нужна ещё и подпись «Agent capture W×H».
    if (spec !== null || !record.visible) deps.activity({ webContentsId: id, session: request.label, op: request.op, phase: 'start', capture: view });
    const taken = spec === null ? await capture() : await deps.emulation.withTemporary(id, spec, capture);
    const png = fitLongSide(taken.png);
    const size = deps.image.size(png);
    const saved = await deps.saveImage(png);
    if (saved === null) throw new AgentOpError('unsupported', 'The screenshot could not be saved to Parley drops.');
    return {
      tab: record.agentId,
      url: redactUrl(contents.getURL()),
      path: saved,
      width: size.width,
      height: size.height,
      viewport: taken.viewport,
      fullPage: args.fullPage === true,
      emulated: spec !== null || deps.emulation.current(id) !== null,
      ...(notes.length === 0 ? {} : { notes }),
    };
  }

  return { screenshotOf };
}
