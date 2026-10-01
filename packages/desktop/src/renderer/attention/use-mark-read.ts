/**
 * «Прочитано» писем человеку (спека 7.2): письмо, которое человек видит, уходит в
 * `mail.markRead`. Видимость — `IntersectionObserver` с порогом 0.5 плюс активность работы,
 * фокус окна и видимый документ: скрытые работы LRU лежат поверх активной с
 * `visibility: hidden`, а наблюдатель CSS-видимость не учитывает.
 *
 * Отметка ставится только по видимости человеку — других действий от его имени нет.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { hostMethods } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';

/** Непрерывная видимость письма до отметки (спека 7.2). */
const VISIBLE_MS = 1000;
/** Пачка уходит через столько тишины (план, «Числа»). */
const BATCH_QUIET_MS = 500;
/** Предел id за вызов — схема `mail.markRead` (план, «Числа»). */
const BATCH_MAX = 500;
/** Потолок отступа повтора после временной ошибки `mail.markRead`. */
const RETRY_MAX_MS = 5000;
/**
 * Коды, на которых повтор бессмыслен: работы или писем уже нет (`not_found`) либо пачку не
 * примет схема (`bad_request`) — те же id ответят так же.
 */
const PERMANENT_CODES = new Set(['not_found', 'bad_request']);
/** Порог видимости письма (спека 7.2). */
const THRESHOLD = 0.5;

interface Input {
  bridge: ParleyBridge;
  projectPath: string;
  workId: string;
  /** Работа активна — LayoutBodyContext.active. Фокус окна и видимость документа хук берёт из store/ui.ts. */
  active: boolean;
}

type RefCallback = (el: HTMLElement | null) => void;

/**
 * Состояние одной панели. Живёт в `ref`, а не в состоянии React: панель перерисовывается на
 * каждое `activity.changed` (`MailBody` подписан на всю активность), и отсчёт не должен
 * зависеть от перерисовок.
 */
class MarkReadEngine {
  input: Input;
  private observer: IntersectionObserver | null = null;
  private readonly idOf = new Map<Element, string>();
  private readonly elementOf = new Map<string, Element>();
  private readonly callbacks = new Map<string, RefCallback>();
  private readonly unread = new Map<string, boolean>();
  private readonly intersecting = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Ушли или ждут в пачке: повторно — только когда снимок работ сменит флаг. */
  private readonly sent = new Set<string>();
  private queue: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Временных ошибок подряд: отступ растёт, чтобы лежащий хост не получал вызов каждые 500 мс. */
  private failures = 0;
  private stopped = false;

  constructor(input: Input) {
    this.input = input;
  }

  /** Колбэк стабилен для одного messageId: перерисовка панели отсчёт не сбрасывает. */
  refFor(messageId: string, unread: boolean): RefCallback {
    this.unread.set(messageId, unread);
    if (!unread) {
      // Снимок обновил письмо — отметка дошла; отсчёт и очередь ему больше не нужны.
      this.sent.delete(messageId);
      this.cancel(messageId);
    }
    let callback = this.callbacks.get(messageId);
    if (callback === undefined) {
      callback = (el) => this.attach(messageId, el);
      this.callbacks.set(messageId, callback);
    }
    return callback;
  }

  /** Фокус, видимость документа или активность работы сменились. */
  reevaluate(): void {
    if (!this.eligible()) {
      for (const id of [...this.timers.keys()]) this.cancel(id);
      return;
    }
    for (const id of this.intersecting) this.maybeStart(id);
  }

  /**
   * Наблюдение за уже прикреплёнными письмами. Отдельно от `attach`: StrictMode снимает и
   * заново ставит эффекты, а ref-колбэки React 18 при этом не перезывает.
   */
  start(): void {
    this.stopped = false;
    for (const el of this.elementOf.values()) this.ensureObserver()?.observe(el);
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    this.intersecting.clear();
    for (const id of [...this.timers.keys()]) this.cancel(id);
    // Уже набравшие 1 с видимости уходят сразу: человек их видел.
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush();
  }

  private eligible(): boolean {
    const ui = useUiStore.getState();
    return this.input.active && ui.windowFocused && ui.documentVisible;
  }

  /** `null` — среды без `IntersectionObserver` (jsdom): видимость не узнать, письма не отмечаются. */
  private ensureObserver(): IntersectionObserver | null {
    if (typeof IntersectionObserver === 'undefined') return null;
    if (this.observer === null) {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = this.idOf.get(entry.target);
            if (id === undefined) continue;
            if (entry.isIntersecting && entry.intersectionRatio >= THRESHOLD) {
              this.intersecting.add(id);
              this.maybeStart(id);
            } else {
              this.intersecting.delete(id);
              this.cancel(id);
            }
          }
        },
        { threshold: THRESHOLD },
      );
    }
    return this.observer;
  }

  private attach(messageId: string, el: HTMLElement | null): void {
    const previous = this.elementOf.get(messageId);
    if (previous !== undefined && previous !== el) {
      this.observer?.unobserve(previous);
      this.idOf.delete(previous);
      this.elementOf.delete(messageId);
      this.intersecting.delete(messageId);
      this.cancel(messageId);
    }
    if (el === null) {
      // Письмо ушло из ленты — колбэк ему больше не нужен.
      this.callbacks.delete(messageId);
      this.unread.delete(messageId);
      return;
    }
    this.idOf.set(el, messageId);
    this.elementOf.set(messageId, el);
    this.ensureObserver()?.observe(el);
  }

  private maybeStart(id: string): void {
    if (this.timers.has(id) || this.sent.has(id) || this.unread.get(id) !== true || !this.eligible()) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        if (!this.intersecting.has(id) || this.unread.get(id) !== true || this.sent.has(id) || !this.eligible()) return;
        this.sent.add(id);
        this.queue.push(id);
        this.scheduleFlush();
      }, VISIBLE_MS),
    );
  }

  private cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    // Во время отступа ждут и новые письма: иначе они сбили бы его обратно к 500 мс.
    const delay = this.failures === 0 ? BATCH_QUIET_MS : Math.min(BATCH_QUIET_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }

  private flush(): void {
    const ids = this.queue;
    this.queue = [];
    if (ids.length === 0) return;
    // Метод проверяется в момент отправки: хост могли перезапустить старой версией, и
    // значение, взятое при монтировании, устарело бы. Старый хост ответил бы unknown_method.
    if (!hostMethods(useHostStore.getState().status).has('mail.markRead')) {
      // Отметки не ушли — письма снова кандидаты при следующем появлении.
      for (const id of ids) this.sent.delete(id);
      return;
    }
    const { bridge, projectPath, workId } = this.input;
    for (let start = 0; start < ids.length; start += BATCH_MAX) {
      const messageIds = ids.slice(start, start + BATCH_MAX);
      bridge
        .call('mail.markRead', { projectPath, workId, messageIds })
        .then(() => {
          this.failures = 0;
        })
        .catch((err: unknown) => {
          // Работа или письма исчезли — пачка выброшена; id остаются в `sent`, чтобы та же
          // пачка не ушла снова при следующем появлении писем.
          if (PERMANENT_CODES.has(decodeIpcError(err).code)) return;
          // id — обратно в очередь следующей пачкой: письмо не застревает до перемонтирования.
          // Панель уже снята — письма снова кандидаты при её следующем монтировании.
          if (this.stopped) {
            for (const id of messageIds) this.sent.delete(id);
            return;
          }
          this.failures += 1;
          this.queue.push(...messageIds);
          this.scheduleFlush();
        });
    }
  }
}

/**
 * Ref-колбэк для элемента письма: непрочитанное, видимое ≥1 с при active, фокусе окна и видимом
 * документе, уходит в mail.markRead пачкой через 500 мс тишины, до 500 id за вызов. `unread` —
 * isHumanUnread(message), а не LetterView.unread: тот значит «хоть один адресат не прочёл».
 * Колбэк стабилен для одного messageId: перерисовка панели отсчёт не сбрасывает.
 */
export function useMarkRead(input: Input): (messageId: string, unread: boolean) => (el: HTMLElement | null) => void {
  const engineRef = useRef<MarkReadEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new MarkReadEngine(input);
  const engine = engineRef.current;
  engine.input = input;

  useEffect(() => {
    engine.reevaluate();
  }, [engine, input.active]);

  useEffect(
    () =>
      useUiStore.subscribe((state, prev) => {
        if (state.windowFocused !== prev.windowFocused || state.documentVisible !== prev.documentVisible) engine.reevaluate();
      }),
    [engine],
  );

  useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, [engine]);

  return useCallback((messageId: string, unread: boolean) => engine.refFor(messageId, unread), [engine]);
}
