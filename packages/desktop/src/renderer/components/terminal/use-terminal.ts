/**
 * Протокольная обвязка одного xterm-терминала вокруг PTY-сессии (кусок 1.11
 * плана окна, спека 5.2/5.3): подключение, пересинхронизация, поток вывода,
 * ввод, ресайз с тишиной и отключение при размонтировании. Терминал живёт,
 * пока есть контейнер в DOM — без него открывать нечего.
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { shouldForwardToTerminal } from '../../lib/keys.js';
import { themeNameToXtermTheme } from './xterm-theme.js';

/** Тишина после последнего ресайза, прежде чем уйдёт `pty.resize` (спека 5.2). */
const RESIZE_SILENCE_MS = 50;

export interface UseTerminalOptions {
  bridge: HarnasBridge;
  ref: SessionRef;
  /** `null`, пока контейнер ещё не смонтирован — терминал ждёт. */
  container: HTMLDivElement | null;
  theme: string;
  fontFamily: string;
  fontSize: number;
}

export interface UseTerminalResult {
  /** Для строки поиска панели (⌘F); `null`, пока терминал не открыт. */
  search: SearchAddon | null;
}

function sameRef(a: SessionRef, b: SessionRef): boolean {
  return a.projectPath === b.projectPath && a.workId === b.workId && a.sessionId === b.sessionId;
}

/** Ссылки открываются наружу только по http/https — как и в основном процессе (`main/ipc.ts#isAllowedExternalUrl`). */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function useTerminal(options: UseTerminalOptions): UseTerminalResult {
  const { ref, container, theme, fontFamily, fontSize } = options;
  const [search, setSearch] = useState<SearchAddon | null>(null);

  // `bridge` стабилен на весь жизненный цикл окна (один `window.harnas`, см.
  // `App.tsx`), но колбэки ниже заведены один раз на монтирование — читают
  // его через ref, а не через замыкание, из тех же соображений.
  const bridgeRef = useRef(options.bridge);
  bridgeRef.current = options.bridge;

  useEffect(() => {
    if (container === null) return;

    const term = new Terminal({
      theme: themeNameToXtermTheme(theme),
      fontFamily,
      fontSize,
      // Параллельно с канвой/WebGL держит реальный DOM-текст экрана — нужен
      // не только читалкам с экрана, но и ручной проверке ⌘C по плану, и
      // будущим E2E, которым иначе пришлось бы читать пиксели канвы.
      screenReaderMode: true,
    });

    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinks = new WebLinksAddon(
      (_event, uri) => {
        if (!isHttpUrl(uri)) return;
        void bridgeRef.current.app.openExternal(uri);
      },
      { urlRegex: /https?:\/\/[^\s]+/g },
    );

    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinks);

    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      webgl.onContextLoss(() => webgl.dispose());
    } catch {
      // WebGL недоступен (headless CI, старый драйвер GPU) — xterm остаётся
      // на обычном canvas-рендере, разницы для пользователя почти нет.
    }

    term.open(container);
    setSearch(searchAddon);

    term.attachCustomKeyEventHandler((event) => {
      // ⌘C при выделении — копия в буфер обмена; сама клавиша дальше не идёт
      // в pty.input, как и любое другое ⌘-сочетание (`lib/keys.ts`).
      if (event.type === 'keydown' && event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
      }
      return shouldForwardToTerminal(event);
    });

    let disposed = false;
    // Вывод, пришедший раньше снимка (гонка attach ⇄ pty.output), копится и
    // дописывается следом — иначе на экране мог бы оказаться кусок вывода
    // до снимка, которому он логически предшествует.
    let snapshotWritten = false;
    let pendingOutput: string[] = [];

    const attach = async (): Promise<void> => {
      snapshotWritten = false;
      pendingOutput = [];
      try {
        const { snapshot, cols, rows } = await bridgeRef.current.call('pty.attach', { ref });
        if (disposed) return;
        term.resize(cols, rows);
        term.write(snapshot);
        snapshotWritten = true;
        for (const chunk of pendingOutput) term.write(chunk);
        pendingOutput = [];
      } catch {
        // Хост ещё не завёл `pty.attach` (куски 1.6/1.7) или сессии уже нет —
        // терминал остаётся пустым вместо падения панели.
      }
    };
    void attach();

    const dataDisposable = term.onData((data) => {
      bridgeRef.current.notify('pty.input', { ref, data });
    });

    const unsubscribeOutput = bridgeRef.current.on('pty.output', (event) => {
      if (!sameRef(event.ref, ref)) return;
      if (!snapshotWritten) {
        pendingOutput.push(event.data);
        return;
      }
      term.write(event.data);
    });

    const unsubscribeResync = bridgeRef.current.on('pty.resync', (event) => {
      if (!sameRef(event.ref, ref)) return;
      term.reset();
      void attach();
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        bridgeRef.current.notify('pty.resize', { ref, cols: term.cols, rows: term.rows });
      }, RESIZE_SILENCE_MS);
    });
    resizeObserver.observe(container);
    fit.fit();

    return () => {
      disposed = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unsubscribeOutput();
      unsubscribeResync();
      bridgeRef.current.call('pty.detach', { ref }).catch(() => {
        // Отключение — лучшее усилие: сокет мог уже закрыться раньше нас.
      });
      setSearch(null);
      term.dispose();
    };
    // Терминал заводится заново только при смене контейнера или сессии.
    // Смена темы/шрифта на лету не поддержана: полей мало, а пересоздавать
    // терминал на каждый ререндер `App`/`SettingsDialog` было бы заметнее
    // пользователю, чем помощь от смены цвета без реаттача.
  }, [container, ref.projectPath, ref.workId, ref.sessionId]);

  return { search };
}
