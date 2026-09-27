/**
 * Протокольная обвязка одного xterm-терминала вокруг PTY-сессии (кусок 1.11
 * плана окна, спека 5.2/5.3): подключение, пересинхронизация, поток вывода,
 * ввод, ресайз с тишиной и отключение при размонтировании. Терминал живёт,
 * пока есть контейнер в DOM — без него открывать нечего.
 *
 * Подключение к хосту (`pty.attach`/`pty.detach`) отдельно от жизни самого
 * xterm-объекта (кусок 2.1 плана окна, «Видимость»): в сетке панель терминала
 * может быть смонтирована, но не быть активной вкладкой своей группы —
 * невидимая вкладка должна отцепиться от хоста, а видимая — подключиться со
 * свежим снимком, без пересоздания xterm и потери его локального состояния.
 * Поэтому подключение управляется отдельным эффектом по параметру `visible`.
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { shouldForwardToTerminal } from '../lib/keys.js';
import { useUiStore } from '../store/ui.js';
import { minimumContrastRatio, XTERM_OPTIONS, xtermTheme } from './xterm-themes.js';

/** Тишина после последнего ресайза, прежде чем уйдёт `pty.resize` (спека 5.2). */
const RESIZE_SILENCE_MS = 50;

export interface UseTerminalOptions {
  bridge: HarnasBridge;
  ref: SessionRef;
  /** `null`, пока контейнер ещё не смонтирован — терминал ждёт. */
  container: HTMLDivElement | null;
  fontFamily: string;
  fontSize: number;
  /**
   * Видна ли панель сейчас (активная вкладка своей группы в сетке). По
   * умолчанию `true` — вне `Workspace` (например, в тестах панели) терминал
   * ведёт себя как раньше: подключается на монтировании, отключается на
   * размонтировании.
   */
  visible?: boolean;
}

export interface UseTerminalResult {
  /** Для строки поиска панели (⌘F); `null`, пока терминал не открыт. */
  search: SearchAddon | null;
  /**
   * Сам xterm — для ручки поверхности (`TerminalSurface.tsx`, кусок 2.5):
   * `focus()` и `scrollToBottom()` из реестра `terminalSurfaces`. `null`, пока
   * терминал не открыт.
   */
  terminal: Terminal | null;
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
  const { ref, container, fontFamily, fontSize, visible = true } = options;
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  // Тёмность — из общего стора (кусок 1.1), не проп: тема терминала должна
  // меняться на лету при смене `.dark`, без пересоздания хука по цепочке
  // App → Workspace → TerminalPanel (спека 4.7).
  const dark = useUiStore((state) => state.dark);
  // Текущий xterm — для отдельного эффекта смены темы ниже: он не должен
  // пересоздавать терминал, поэтому держит ссылку на уже созданный объект
  // вместо того, чтобы быть в зависимостях эффекта создания.
  const termRef = useRef<Terminal | null>(null);

  // `bridge` стабилен на весь жизненный цикл окна (один `window.harnas`, см.
  // `App.tsx`), но колбэки ниже заведены один раз на монтирование — читают
  // его через ref, а не через замыкание, из тех же соображений.
  const bridgeRef = useRef(options.bridge);
  bridgeRef.current = options.bridge;

  // Видимость для `ResizeObserver` ниже (кусок 2.5): тот заведён один раз на
  // создание терминала, а размер PTY задаёт только видимая поверхность —
  // скрытая (в слое их много: все вкладки трёх работ) слала бы хосту чужой
  // размер. Поэтому колбэк читает свежую видимость через ref.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Мост между эффектом создания xterm (ниже) и эффектом видимости (в конце
  // функции): подключение к хосту должно переживать переключение вкладок без
  // пересоздания самого терминала, поэтому `attach`/`detach` живут в ref, а не
  // вызываются напрямую из эффекта создания.
  const attachRef = useRef<(() => Promise<void>) | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (container === null) return;

    const term = new Terminal({
      ...XTERM_OPTIONS,
      theme: xtermTheme(useUiStore.getState().dark),
      minimumContrastRatio: minimumContrastRatio(useUiStore.getState().dark),
      fontFamily,
      fontSize,
      // screenReaderMode не включаем: в нём xterm игнорирует события
      // insertText, а через них приходят выбор эмодзи, диктовка и буквы с
      // диакритикой по долгому нажатию в macOS — ввод терялся бы.
    });
    termRef.current = term;

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

    term.open(container);

    // WebGL-аддон подключается только после open: до него у терминала нет
    // элемента. E2E просят DOM-рендер (`?renderer=dom`), чтобы читать текст
    // экрана, а не пиксели канвы.
    if (!domRendererRequested()) {
      try {
        const webgl = new WebglAddon();
        term.loadAddon(webgl);
        webgl.onContextLoss(() => webgl.dispose());
      } catch {
        // WebGL недоступен (старый драйвер GPU) — xterm остаётся на DOM-рендере.
      }
    }
    setSearch(searchAddon);
    setTerminal(term);

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
    // Подключены ли мы сейчас к выводу хоста — эффект видимости дальше по
    // файлу включает и выключает это через `attach`/`detach`; вывод и
    // «просмотрено» (`markSeen` на хосте — побочный эффект `pty.attach`) не
    // должны доставаться невидимой вкладке (кусок 2.1, тест 5а).
    let connected = false;
    // Экран сбрасывается перед КАЖДЫМ повторным подключением (пересинхрон,
    // возврат видимости) — иначе новый снимок лёг бы поверх старого экрана.
    // Самое первое подключение сбрасывать незачем: терминал и так пуст.
    let everConnected = false;

    const attach = async (): Promise<void> => {
      if (everConnected) term.reset();
      everConnected = true;
      connected = true;
      snapshotWritten = false;
      pendingOutput = [];
      try {
        const { snapshot, cols, rows } = await bridgeRef.current.call('pty.attach', { ref });
        if (disposed || !connected) return;
        term.resize(cols, rows);
        term.write(snapshot);
        snapshotWritten = true;
        for (const chunk of pendingOutput) term.write(chunk);
        pendingOutput = [];
        // Размер окна главнее размера хоста (раунд исправлений 1, находка
        // B№2): у только что созданного PTY хост ещё не получал ни одного
        // pty.resize и отвечает своим DEFAULT_SIZE (packages/host/src/pty/
        // pty-manager.ts) — тот не совпадает с реальным размером контейнера,
        // и терминал недозаполняет панель до следующего ресайза окна. fit()
        // после снимка подбирает актуальный размер по контейнеру; если он не
        // совпал с тем, что применили выше, сообщаем хосту наш размер прямым
        // pty.resize — не через debounce-таймер ниже, это разовая поправка
        // сразу после attach, а не серия ресайзов контейнера.
        fit.fit();
        if (term.cols !== cols || term.rows !== rows) {
          bridgeRef.current.notify('pty.resize', { ref, cols: term.cols, rows: term.rows });
        }
      } catch {
        // Хост ещё не завёл `pty.attach` (куски 1.6/1.7) или сессии уже нет —
        // терминал остаётся пустым вместо падения панели.
      }
    };

    const detach = (): void => {
      if (!connected) return;
      connected = false;
      bridgeRef.current.call('pty.detach', { ref }).catch(() => {
        // Отключение — лучшее усилие: сокет мог уже закрыться раньше нас.
      });
    };

    attachRef.current = attach;
    detachRef.current = detach;

    const dataDisposable = term.onData((data) => {
      bridgeRef.current.notify('pty.input', { ref, data });
    });

    const unsubscribeOutput = bridgeRef.current.on('pty.output', (event) => {
      if (!sameRef(event.ref, ref) || !connected) return;
      if (!snapshotWritten) {
        pendingOutput.push(event.data);
        return;
      }
      term.write(event.data);
    });

    const unsubscribeResync = bridgeRef.current.on('pty.resync', (event) => {
      if (!sameRef(event.ref, ref)) return;
      void attach();
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      // Скрытая поверхность изменения размера пропускает: при появлении
      // `attach()` сам сделает `fit()` и при расхождении с хостом один
      // `pty.resize` (правило 1.3) — отдельный resize тут дал бы второй SIGWINCH.
      if (!visibleRef.current) return;
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
      // Само отключение от хоста — забота эффекта видимости ниже: React чистит
      // эффекты одного рендера в порядке их объявления (этот — первым), так
      // что на размонтировании эффект видимости всё ещё дозвонится до
      // `pty.detach` через `detachRef` следом за этой функцией — рефы нарочно
      // не обнуляются здесь, иначе к его цепочке "если видима — отключиться"
      // подключаться было бы уже не от чего, и на каждое закрытие панели
      // осело бы на один `pty.detach` меньше, чем нужно.
      setSearch(null);
      setTerminal(null);
      termRef.current = null;
      term.dispose();
    };
    // Терминал заводится заново только при смене контейнера или сессии.
    // Шрифт (`fontFamily`/`fontSize`) на лету не подхватывается: полей мало, а
    // пересоздавать терминал на каждый ререндер `App`/`SettingsDialog` было бы
    // заметнее пользователю, чем помощь от смены шрифта без реаттача. Тема —
    // исключение (спека 4.7): её меняет отдельный эффект ниже через
    // `term.options`, без пересоздания.
  }, [container, ref.projectPath, ref.workId, ref.sessionId]);

  // Смена темы на лету при переключении `.dark`, без пересоздания терминала
  // (спека 4.7): `dark` нарочно не входит в зависимости эффекта создания
  // выше — иначе каждое переключение темы пересоздавало бы xterm и роняло
  // его локальное состояние (скролл, выделение).
  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = xtermTheme(dark);
    term.options.minimumContrastRatio = minimumContrastRatio(dark);
  }, [dark]);

  // Подключение к хосту следует видимости, а не монтированию: невидимая
  // вкладка отцепляется (без потери самого xterm выше), видимая — цепляется
  // заново со свежим снимком (спека 5.1, «Видимость», кусок 2.1). Эффект
  // сам обязан быть в паре с созданием терминала — тот же список
  // зависимостей плюс `visible`, иначе после пересоздания терминала (эффект
  // выше) с тем же `visible` подключения бы не случилось вовсе.
  useEffect(() => {
    if (visible) void attachRef.current?.();
    return () => detachRef.current?.();
  }, [visible, container, ref.projectPath, ref.workId, ref.sessionId]);

  return { search, terminal };
}

/** Окно открыто с `?renderer=dom` — так его открывает main при HARNAS_TERMINAL_RENDERER=dom. */
function domRendererRequested(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('renderer') === 'dom';
  } catch {
    return false;
  }
}
