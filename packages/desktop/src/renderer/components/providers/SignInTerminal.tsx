/**
 * Терминал входа в аккаунт подписки (спека подписок 4.1, 5.5, 10): тот же xterm и та же тема, что у сессий, но вход —
 * отдельный маленький путь PTY без `pty-manager` сессий. Вывод приходит событием `providers.signInOutput`, ввод
 * (код из браузера) уходит `providers.signInInput`, размер — `providers.signInResize`.
 *
 * Хост вывод не повторяет, поэтому терминал при монтировании сначала пишет то, что стор накопил с `init`
 * (`store/providers.ts`), и только потом слушает живые куски: чтение буфера и подписка идут в одном синхронном шаге,
 * между ними вывод не теряется и не удваивается. Рендерер DOM (без WebGL, поиска и ссылок): терминал маленький, а
 * текст экрана должен читаться тестами и E2E.
 */

import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { S } from '../../../shared/strings.js';
import { useProvidersStore } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { minimumContrastRatio, XTERM_OPTIONS, xtermTheme } from '../../terminal/xterm-themes.js';

/** Тишина после последнего изменения контейнера, прежде чем уйдёт `providers.signInResize` (как `pty.resize`, спека 5.2). */
const RESIZE_SILENCE_MS = 50;
/** Шрифт по умолчанию окна: настройки терминала сессий (`config.fontFamily`) сюда не доходят, терминал входа маленький. */
const FONT_FAMILY = "'SF Mono', Menlo, monospace";
const FONT_SIZE = 12;

export interface SignInTerminalProps {
  /** Id аккаунта. */
  provider: string;
  /**
   * Процесс входа уже поднят хостом. Размер уходит хосту, только пока он жив: при монтировании посреди входа и в
   * момент, когда `running` становится `true` (процесс поднялся уже после монтирования — раньше `resize` пропал бы
   * впустую).
   */
  running: boolean;
}

export function SignInTerminal({ provider, running }: SignInTerminalProps): JSX.Element {
  const dark = useUiStore((state) => state.dark);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sendSizeRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const bridge = window.parley;
    const term = new Terminal({
      ...XTERM_OPTIONS,
      theme: xtermTheme(useUiStore.getState().dark),
      minimumContrastRatio: minimumContrastRatio(useUiStore.getState().dark),
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      scrollback: 1_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const sendSize = (): void => {
      if (!runningRef.current) return;
      void bridge.call('providers.signInResize', { provider, cols: term.cols, rows: term.rows }).catch(() => {
        // Процесса входа уже нет (вышел раньше, чем дошёл размер) — терминалу это не мешает.
      });
    };
    sendSizeRef.current = sendSize;

    const buffered = useProvidersStore.getState().signInOutput[provider] ?? '';
    if (buffered !== '') term.write(buffered);
    const offOutput = bridge.on('providers.signInOutput', (event) => {
      if (event.provider === provider) term.write(event.data);
    });
    const onData = term.onData((data) => {
      void bridge.call('providers.signInInput', { provider, data }).catch(() => {
        // Вход уже закончился: набранное некому принять.
      });
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        sendSize();
      }, RESIZE_SILENCE_MS);
    });
    resizeObserver.observe(container);

    const themeFollower = useUiStore.subscribe((state, previous) => {
      if (state.dark === previous.dark) return;
      term.options.theme = xtermTheme(state.dark);
      term.options.minimumContrastRatio = minimumContrastRatio(state.dark);
    });

    return () => {
      themeFollower();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      sendSizeRef.current = null;
      onData.dispose();
      offOutput();
      term.dispose();
    };
  }, [provider]);

  // Первый размер: при монтировании посреди входа или когда процесс поднялся после монтирования. Эффект стоит после
  // эффекта создания xterm — `sendSizeRef` к этому шагу уже заполнен.
  useEffect(() => {
    if (running) sendSizeRef.current?.();
  }, [running, provider]);

  return (
    <div
      data-sign-in-terminal=""
      role="group"
      aria-label={S.accounts.terminalLabel}
      className="rounded-xl p-2"
      style={{ backgroundColor: xtermTheme(dark).background }}
    >
      <div ref={containerRef} className="h-40 w-full overflow-hidden" />
    </div>
  );
}
