/**
 * Снимок страницы для агента (спека 2026-10-07-browser-devtools-agent-design.md, 5.1, 8): размер, временная эмуляция,
 * «поверхность снимка», fullPage по полосам, повтор снимка невидимой страницы, сохранение в `drops/`.
 *
 * Поверхность снимка (спайк 0 плана исправлений): Chromium рисует кадр только в размере самого `<webview>` — при эмуляции
 * больше панели PNG выходил с повтором верхнего левого куска. Поэтому, пока идёт снимок в чужом размере или снимок невидимой
 * страницы, окно ставит `<webview>` в размер снимка и подтверждает это (`captureReady`); main снимает только после подтверждения.
 * fullPage не растит поверхность: страница прокручивается вьюпортом, полосы склеиваются.
 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import type { BrowserAgentArgs, BrowserAgentOpEvent, BrowserAgentScreenshotResult } from '@parley/protocol';
import { VIEWPORT_PRESETS, viewportSize } from '../../shared/browser-devtools.js';
import type { ViewportPreset, ViewportSpec } from '../../shared/browser-devtools.js';
import type { AgentActivity } from '../../shared/browser-types.js';
import { redactUrl } from '../../shared/redact.js';
import { AgentOpError } from './agent-errors.js';
import type { LayoutMetrics, PageRecord, PageRegistry } from './agent-pages.js';
import type { Emulation } from './emulation.js';
import type { Inspector } from './inspector.js';
import { pngSize } from './png.js';
import { isLoopbackUrl } from '../../shared/loopback.js';

/** Размер снимка агента: совпал с пресетом в любой ориентации — пресет, иначе Custom; DPR 1 — PNG в CSS-пикселях. */
export function captureSpec(width: number, height: number): ViewportSpec {
  for (const [preset, size] of Object.entries(VIEWPORT_PRESETS) as Array<[ViewportPreset, { width: number; height: number }]>) {
    if (size.width === width && size.height === height) return { preset, rotated: false, dpr: 1 };
    if (size.width === height && size.height === width) return { preset, rotated: true, dpr: 1 };
  }
  return { width, height, mobile: false, dpr: 1 };
}

/** Во сколько раз сужается снимок при повторе, когда PNG не влез в `AGENT_LIMITS.screenshotBytes`. */
const OVERSIZE_FACTOR = 0.7;
/** Сколько раз повторяют снимок, не влезший в предел байт. */
const OVERSIZE_RETRIES = 2;

/** Отношение пикселей устройства к CSS-пикселям вьюпорта; не число или не больше нуля — 1. */
export function dprOf(metrics: LayoutMetrics): number {
  const ratio = metrics.layoutViewport?.clientWidth / metrics.cssLayoutViewport.clientWidth;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** Пауза перед повтором снимка невидимой страницы, мс. */
const CAPTURE_RETRY_MS = 50;

/**
 * Поверхность выше этой доли высоты окна Chromium тайлит (страница повторяется; спайк 0, поправка 3: 900 → верно до 1100,
 * 1300 тайлится). Запас взят с края: 1080 при окне 900 проходит, 1440 — нет.
 */
const SURFACE_HEIGHT_FACTOR = 1.2;

/** Область снимка в CSS-пикселях страницы и масштаб PNG (`Page.captureScreenshot.clip`). */
interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface AgentCaptureDeps {
  inspector: Pick<Inspector, 'send' | 'snapshot'>;
  emulation: Pick<Emulation, 'current' | 'withTemporary'>;
  /** DPR окна, в котором лежит гость (`window.devicePixelRatio` окна); `null` или метода нет — по `Page.getLayoutMetrics` (без эмуляции человека), иначе 1. */
  screenDpr?(contents: WebContents): Promise<number | null>;
  registry: Pick<PageRegistry, 'fresh'>;
  saveImage(png: Buffer): Promise<string | null>;
  image: {
    resize(png: Buffer, width: number, height: number): Buffer;
    stitch(parts: Buffer[]): Buffer;
    /** Строки PNG `top`…`top + height` (в пикселях картинки) на всю её ширину. */
    crop(png: Buffer, top: number, height: number): Buffer;
  };
  activity(e: AgentActivity): void;
  /**
   * Код main в мире гостя, изолированном от скриптов страницы (прокрутка fullPage): ответ — значение последнего выражения.
   * `Runtime.evaluate` инспектора закрыт навсегда (список `CDP_ALLOWED`), и этот путь не нарушает запрета: код здесь только
   * константы `agent-capture.ts` с целыми числами, агент своего JS не передаёт.
   */
  inGuest(contents: WebContents, code: string): Promise<unknown>;
  /** Высота содержимого окна, в котором лежит гость; `null` или метода нет — проверка размера снимка пропускается. */
  windowHeight?(contents: WebContents): number | null;
  /** Сколько ждать подтверждения окна; по умолчанию `AGENT_LIMITS.captureReadyMs`. Тестам — меньше. */
  captureReadyMs?: number;
}

export interface AgentCapture {
  screenshotOf(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentArgs<'screenshot'>, signal: AbortSignal): Promise<BrowserAgentScreenshotResult>;
  /** Окно подтверждает поверхность снимка (`browser:agent-capture-ready`); чужой и поздний id молча игнорируется. */
  captureReady(id: string): void;
}

export function createAgentCapture(deps: AgentCaptureDeps): AgentCapture {
  const readyMs = deps.captureReadyMs ?? AGENT_LIMITS.captureReadyMs;
  /** Ждущие подтверждения окна: id поверхности → продолжение. */
  const pendingSurfaces = new Map<string, () => void>();

  /** Просит окно поставить `<webview>` в размер снимка и ждёт подтверждения не дольше `readyMs`. */
  function prepareSurface(contents: WebContents, request: BrowserAgentOpEvent, view: { width: number; height: number }): Promise<void> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSurfaces.delete(id);
        reject(new AgentOpError('timeout', `Parley's window did not prepare the page for the screenshot within ${Math.round(readyMs / 1000)} s.`));
      }, readyMs);
      pendingSurfaces.set(id, () => {
        clearTimeout(timer);
        pendingSurfaces.delete(id);
        resolve();
      });
      deps.activity({ webContentsId: contents.id, session: request.label, op: request.op, phase: 'start', capture: { ...view, id } });
    });
  }

  /** Длинная сторона PNG — не больше `AGENT_LIMITS.screenshotLongSide` (предел картинки, которую модель читает целиком). */
  function fitLongSide(png: Buffer): Buffer {
    const size = pngSize(png);
    const long = Math.max(size.width, size.height);
    if (long <= AGENT_LIMITS.screenshotLongSide) return png;
    const scale = AGENT_LIMITS.screenshotLongSide / long;
    return deps.image.resize(png, Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
  }

  async function screenshotOf(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentArgs<'screenshot'>, signal: AbortSignal): Promise<BrowserAgentScreenshotResult> {
    const id = contents.id;
    const metrics = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
    // Эпоха документа до съёмки: после неё сверяется, что страница не сменилась посреди снимка (аудит 3.2, R2).
    const epoch0 = deps.inspector.snapshot(id)?.epoch;
    const current = { width: Math.round(metrics.cssLayoutViewport.clientWidth), height: Math.round(metrics.cssLayoutViewport.clientHeight) };
    const spec = args.width === undefined && args.height === undefined ? null : captureSpec(args.width ?? current.width, args.height ?? current.height);
    const view = spec === null ? current : (({ width, height }) => ({ width, height }))(viewportSize(spec));
    if (spec !== null) {
      const windowHeight = deps.windowHeight?.(contents) ?? null;
      const limit = windowHeight === null ? null : Math.floor(windowHeight * SURFACE_HEIGHT_FACTOR);
      if (limit !== null && view.height > limit) {
        throw new AgentOpError('bad_request', `A screenshot ${view.height} px tall does not fit Parley's window (up to ${limit} px): ask for a smaller height, or use fullPage to scroll through a tall page.`);
      }
    }

    /** Поверхность снимка уже поставлена окном (один раз за снимок: размер не меняется). */
    let surfaced = false;
    const ensureSurface = async (): Promise<void> => {
      if (surfaced) return;
      await prepareSurface(contents, request, view);
      surfaced = true;
    };

    const shoot = async (clip: Clip | null): Promise<Buffer> => {
      for (let failures = 0; ; ) {
        try {
          const shot = await deps.inspector.send<{ data: string }>(id, 'Page.captureScreenshot', clip === null ? { format: 'png' } : { format: 'png', clip });
          return Buffer.from(shot.data, 'base64');
        } catch (error) {
          // Видимость читается из реестра сейчас: за время снимка человек мог показать страницу или спрятать её.
          const hidden = (deps.registry.fresh(record) ?? record).visible === false;
          if (!hidden) throw error;
          if (!surfaced) {
            // Спрятали посреди снимка: поверхность ещё не готовили.
            await ensureSurface();
            continue;
          }
          failures += 1;
          if (failures > AGENT_LIMITS.captureRetries) {
            throw new AgentOpError('tab_hidden', `Page ${record.agentId} is not shown to the human and Chromium does not draw it: ask them to open its browser panel, or read browser_console and browser_network.`);
          }
          await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS));
        }
      }
    };

    const evaluate = (code: string): Promise<unknown> => deps.inGuest(contents, code);

    const notes: string[] = [];
    /**
     * Клип с масштабом уменьшает PNG прямо в Chromium, без декода на main, но на экране с DPR > 1 он ненадёжен: сразу после
     * смены размера Chromium отдаёт то верный кадр, то неверную четверть страницы (спайк 0, В3; повтор пробы на DPR 2 дал то же).
     * Поэтому клип — только на экране с DPR 1; fullPage его не берёт: полосы склеиваются на main, длинная сторона режется после
     * склейки. Эмуляция на экране DPR > 1 берёт DPR экрана (`withTemporary`): с DPR 1 она не действует и кадр выходит четвертью.
     */
    const screenDpr = (await deps.screenDpr?.(contents)) ?? (deps.emulation.current(id) === null ? dprOf(metrics) : 1);
    const canClip = args.fullPage !== true && screenDpr <= 1;
    /** Масштаб PNG: длинная сторона не больше предела картинки; `factor` — сужение при повторе. */
    const scaleFor = (cssWidth: number, cssHeight: number, factor: number): number =>
      Math.min(1, AGENT_LIMITS.screenshotLongSide / Math.max(cssWidth, cssHeight)) * factor;
    type Taken = { png: Buffer; viewport: { width: number; height: number }; clipped: boolean };
    const takeOnce = async (factor: number): Promise<Taken> => {
      signal.throwIfAborted();
      // Место вьюпорта и высота страницы — сейчас, при поставленной эмуляции и поверхности: в начале операции там были размеры человека.
      const now = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
      if (args.fullPage !== true) {
        const scale = scaleFor(view.width, view.height, factor);
        const clip = { x: now.cssLayoutViewport.pageX, y: now.cssLayoutViewport.pageY, width: view.width, height: view.height, scale };
        return { png: await shoot(canClip && scale < 1 ? clip : null), viewport: view, clipped: canClip };
      }
      // Высота страницы — уже при нужном размере (под временной эмуляцией вёрстка другая).
      const content = Math.max(view.height, Math.ceil(now.cssContentSize.height));
      const total = Math.min(content, view.height * AGENT_LIMITS.fullPageViewports);
      if (content > total && factor === 1) notes.push(`The page is ${content} px tall; the screenshot shows the first ${total} px (${AGENT_LIMITS.fullPageViewports} viewport heights).`);
      const wide = Math.ceil(now.cssContentSize.width);
      if (wide > view.width && factor === 1) notes.push(`The page is ${wide} px wide; the screenshot shows the first ${view.width} px.`);
      const origin = await evaluate('[window.scrollX, window.scrollY]');
      const strips: Buffer[] = [];
      try {
        // Полоса вне вида рисуется повтором верха (спайк 0, поправка 2): страницу прокручивают вьюпортом, по снимку на полосу.
        for (let y = 0; y < total; y += view.height) {
          signal.throwIfAborted();
          const reached = await evaluate(
            `new Promise((done) => { window.scrollTo(0, ${y}); const finish = () => done(window.scrollY); setTimeout(finish, 300); requestAnimationFrame(() => requestAnimationFrame(finish)); })`,
          );
          // Последняя полоса: прокрутка зажата у конца документа, нужные строки лежат ниже верха снимка.
          const at = typeof reached === 'number' ? reached : y;
          const rows = Math.min(view.height, total - y);
          const skip = Math.max(0, y - at);
          const shot = await shoot(null);
          if (skip === 0 && rows === view.height) {
            strips.push(shot);
          } else {
            const ratio = pngSize(shot).width / view.width;
            strips.push(deps.image.crop(shot, Math.round(skip * ratio), Math.round(rows * ratio)));
          }
        }
      } finally {
        // Человек не должен видеть, что страницу прокручивали.
        const [x, top] = Array.isArray(origin) ? (origin as unknown[]) : [0, 0];
        if (typeof x === 'number' && typeof top === 'number') await evaluate(`window.scrollTo(${x}, ${top})`).catch(() => undefined);
      }
      return { png: strips.length === 1 ? (strips[0] as Buffer) : deps.image.stitch(strips), viewport: { width: view.width, height: total }, clipped: false };
    };
    const capture = async (): Promise<{ png: Buffer; viewport: { width: number; height: number } }> => {
      if (spec !== null || (deps.registry.fresh(record) ?? record).visible === false) await ensureSurface();
      // PNG, не влезший в предел байт, снимается ещё раз уже (клип с масштабом — картинку на main не декодируем); без клипа
      // (экран с DPR > 1) уменьшается уже снятая.
      let taken = await takeOnce(1);
      for (let attempt = 1, factor = OVERSIZE_FACTOR; taken.png.length > AGENT_LIMITS.screenshotBytes; attempt += 1, factor *= OVERSIZE_FACTOR) {
        if (attempt > OVERSIZE_RETRIES) {
          throw new AgentOpError('unsupported', `The screenshot is too large (over ${Math.round(AGENT_LIMITS.screenshotBytes / 1_000_000)} MB even after reducing it): take a screenshot of a smaller size or of part of the page.`);
        }
        if (taken.clipped) {
          taken = await takeOnce(factor);
        } else {
          signal.throwIfAborted();
          const size = pngSize(taken.png);
          taken = { ...taken, png: deps.image.resize(taken.png, Math.max(1, Math.round(size.width * OVERSIZE_FACTOR)), Math.max(1, Math.round(size.height * OVERSIZE_FACTOR))) };
        }
      }
      return { png: taken.png, viewport: taken.viewport };
    };

    const taken = spec === null ? await capture() : screenDpr > 1 ? await deps.emulation.withTemporary(id, spec, capture, screenDpr) : await deps.emulation.withTemporary(id, spec, capture);
    // Страница могла уйти с localhost или сменить документ, пока снимали (редирект dev-сервера): чужое в drops не кладём.
    if (!isLoopbackUrl(contents.getURL())) {
      throw new AgentOpError('not_loopback', `Page ${record.agentId} left localhost during the screenshot; nothing was saved.`);
    }
    if (deps.inspector.snapshot(id)?.epoch !== epoch0) {
      throw new AgentOpError('tab_not_loaded', `Page ${record.agentId} navigated during the screenshot: take it again.`);
    }
    signal.throwIfAborted();
    const png = fitLongSide(taken.png);
    const size = pngSize(png);
    signal.throwIfAborted();
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

  return {
    screenshotOf,
    captureReady(id) {
      pendingSurfaces.get(id)?.();
    },
  };
}
