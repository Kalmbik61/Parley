/**
 * Экран Claude Code с ползунком `/effort` для тестов смены effort (спека нормалайзера, 5.7): `PtyManager` без
 * процесса, который отвечает на печать хоста так, как Claude Code 2.1.289 на живой проверке 2026-10-06.
 * `/effort` и Enter открывают ползунок со строкой подсказки, `←`/`→` двигают уровень с упором в края, `s`
 * закрывает ползунок и показывает уровень в подвале, Esc закрывает ползунок без изменений.
 */

import type { SessionRef } from '@parley/protocol';
import type { EffortSwitchDeps } from '../src/pty/effort-switch.js';
import type { PtyManager } from '../src/pty/pty-manager.js';

/** Уровни ползунка Claude Code по порядку. */
export const SLIDER_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Строки открытого ползунка, как их рисует Claude Code 2.1.289. */
export const SLIDER_LINES = ['Effort', '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'];

/** Знак подвала по уровню (у `xhigh` — «◉»: «◉ xhigh · /effort»); разбор подвала от знака не зависит. */
const GLYPHS: Record<string, string> = { low: '○', medium: '◐', high: '●', xhigh: '◉', max: '◈' };

/** Подвал после `s`: «◐ medium · /effort». */
export const footerLine = (level: string): string => `  ${GLYPHS[level] ?? '◇'} ${level} · /effort`;

export interface FakeEffortScreen {
  deps: EffortSwitchDeps;
  /** Тот же экран для обработчика `sessions.setEffort`: он ещё держит черновик хоста. */
  pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText' | 'setHostDraft'>;
  /** Всё, что напечатал хост, по вызовам `write`. */
  writes: string[];
  /** Черновик хоста по вызовам `setHostDraft`: пока ползунок открыт, будильник не печатает. */
  hostDrafts: boolean[];
  live: boolean;
  /** Неотправленный текст в поле ввода (`PtyHandle.hasDraft`). */
  draft: boolean;
  /** Открывает ли Enter после `/effort` ползунок. */
  opens: boolean;
  /** Верхний уровень, который примет CLI (как предел администратора); `null` — предела нет. */
  cap: string | null;
  /** `s` теряется: ползунок остаётся открытым, подвал — прежним. */
  dropS: boolean;
  /** Через сколько мс после `s` подвал покажет новый уровень; до того — прежний. */
  footerDelayMs: number;
  /** Уровень в подвале; `null` — подвала с уровнем нет. */
  footer: string | null;
  sliderOpen: boolean;
}

export function fakeEffortScreen(footer: string | null): FakeEffortScreen {
  let input = '';
  let position = 0;
  const state: FakeEffortScreen = {
    deps: undefined as unknown as EffortSwitchDeps,
    pty: undefined as unknown as FakeEffortScreen['pty'],
    writes: [],
    hostDrafts: [],
    live: true,
    draft: false,
    opens: true,
    cap: null,
    dropS: false,
    footerDelayMs: 0,
    footer,
    sliderOpen: false,
  };

  const show = (level: string): void => {
    if (state.footerDelayMs === 0) {
      state.footer = level;
      return;
    }
    setTimeout(() => {
      state.footer = level;
    }, state.footerDelayMs);
  };

  const press = (data: string): void => {
    if (!state.sliderOpen) {
      if (data === '\r' && input === '/effort' && state.opens) {
        state.sliderOpen = true;
        position = Math.max(0, SLIDER_LEVELS.indexOf(state.footer ?? 'medium'));
      }
      input = data === '\r' || data === '\x1b' ? '' : input + data;
      return;
    }
    if (data === '\x1b[D') position = Math.max(0, position - 1);
    else if (data === '\x1b[C') position = Math.min(SLIDER_LEVELS.length - 1, position + 1);
    else if (data === '\x1b') state.sliderOpen = false;
    else if (data === 's' && !state.dropS) {
      state.sliderOpen = false;
      const top = state.cap === null ? SLIDER_LEVELS.length - 1 : SLIDER_LEVELS.indexOf(state.cap);
      show(SLIDER_LEVELS[Math.min(position, top)] as string);
    }
  };

  state.pty = {
    // Процесс «запущен» в нулевую миллисекунду: хук после старта (`hookedSince`) задаёт активность теста.
    get: (ref: SessionRef) => (state.live ? ({ ref, startedAt: 0, hasDraft: () => state.draft } as never) : undefined),
    write: (_ref: SessionRef, data: string) => {
      state.writes.push(data);
      press(data);
    },
    // Подвал — не последняя строка: ниже пустая, как у короткого разговора.
    screenText: () =>
      state.live
        ? [
            '',
            'Claude Code',
            `> ${input}`,
            ...(state.sliderOpen ? SLIDER_LINES : []),
            ...(state.footer === null ? [] : [footerLine(state.footer)]),
            '',
          ]
        : undefined,
    on: () => () => {},
    setHostDraft: (_ref: SessionRef, value: boolean) => {
      state.hostDrafts.push(value);
    },
  } as unknown as FakeEffortScreen['pty'];
  state.deps = { pty: state.pty };
  return state;
}
