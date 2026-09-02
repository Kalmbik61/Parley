import { useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';

export type PaneId = 'sessions' | 'subsessions' | 'terminal';

/** Порядок обхода по Tab из specs/ui.md. */
const PANES: readonly PaneId[] = ['sessions', 'subsessions', 'terminal'];

export interface NavigationState {
  focus: PaneId;
  selectedSession: number;
  selectedSubsession: number;
  setFocus: (pane: PaneId) => void;
  /** Выбор списка задаётся снаружи: смена режима и свёртка работы двигают его. */
  select: (at: number) => void;
}

export interface NavigationOptions {
  sessionCount: number;
  /**
   * Геттер, а не число: подсессии грузятся ПОСЛЕ того, как выбрана сессия, поэтому
   * их количество известно только к моменту нажатия клавиши.
   */
  getSubsessionCount: () => number;
  /** `r` — принудительный ре-скан. */
  onRescan?: () => void;
  /** Enter на списке сессий — открыть выбранную в правой панели. */
  onOpen?: (index: number) => void;
  /** `R` — перезапустить завершившегося агента. */
  onRestart?: () => void;
  /** `p` — переключить фильтр по провайдеру. */
  onCycleProvider?: () => void;
  /** `n` — запустить нового агента без истории. */
  onNewSession?: () => void;
  /** `w` — переключить режим левой колонки: все сессии ↔ работы. */
  onToggleMode?: () => void;
  /** `←` / `h` — свернуть выбранную работу (режим работ). */
  onCollapse?: () => void;
  /** `→` / `l` — развернуть выбранную работу (режим работ). */
  onExpand?: () => void;
  /**
   * Действует ли `n`. В режиме работ она открывает диалог «новая сессия в работе»
   * (дизайн 4.2), которого ещё нет: до него клавиша молчит и фокус остаётся на
   * списках — запускать агента по индексу чужого списка нельзя.
   */
  newSessionEnabled?: boolean;
  /**
   * Открывать ли правую панель по Enter. В режиме работ Enter на работе только
   * сворачивает её — фокус при этом остаётся на списках (дизайн TUI, раздел 8).
   */
  focusTerminalOnOpen?: boolean;
  /** Любая клавиша в списках: ею гаснут события строки статуса без источника. */
  onKey?: () => void;
  /**
   * В правой панели работает живой процесс, и весь ввод принадлежит ему.
   * Пока там плейсхолдер или процесс уже завершился, панель обычная: Tab и q
   * работают как везде, иначе фокус оказался бы в ловушке.
   */
  terminalCaptures?: boolean;
}

const clamp = (value: number, count: number): number =>
  count === 0 ? 0 : Math.max(0, Math.min(value, count - 1));

/**
 * Стрелки и j/k двигают активный список, Tab переключает панели, q и Ctrl+C выходят.
 * В v1 выход по q будет запрещён, пока фокус на терминале: там весь ввод уходит в PTY
 * (specs/pty.md).
 */
export function useNavigation({
  sessionCount,
  getSubsessionCount,
  onRescan,
  onOpen,
  onRestart,
  onCycleProvider,
  onNewSession,
  onToggleMode,
  onCollapse,
  onExpand,
  onKey,
  newSessionEnabled = true,
  focusTerminalOnOpen = true,
  terminalCaptures = false,
}: NavigationOptions): NavigationState {
  const { exit } = useApp();
  const [focus, setFocus] = useState<PaneId>('sessions');
  const [selectedSession, setSelectedSession] = useState(0);
  const [selectedSubsession, setSelectedSubsession] = useState(0);

  // Список живой: после ре-скана выбор может оказаться за пределами.
  useEffect(() => setSelectedSession((at) => clamp(at, sessionCount)), [sessionCount]);
  // Сменили сессию — подсессии другие, выбор начинается заново.
  useEffect(() => setSelectedSubsession(0), [selectedSession]);

  useInput((input, key) => {
    // Живой агент забирает весь ввод, включая q и Ctrl+C; вернуть фокус можно
    // только escape-клавишей, и делает это usePtyInput.
    if (focus === 'terminal' && terminalCaptures) return;
    onKey?.();

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }

    if (key.tab) {
      setFocus((current) => PANES[(PANES.indexOf(current) + 1) % PANES.length] ?? 'sessions');
      return;
    }

    // Регистр различает действия: r — ре-скан списка, R — перезапуск агента.
    if (input === 'r') {
      onRescan?.();
      return;
    }

    if (input === 'R') {
      onRestart?.();
      return;
    }

    if (input === 'p') {
      onCycleProvider?.();
      return;
    }

    if (input === 'w') {
      onToggleMode?.();
      return;
    }

    // Дерево работ: свернуть и развернуть — единственный способ пройти работу
    // с двумя десятками сессий, не прокручивая её целиком (дизайн 6.6). Клавиши
    // принадлежат списку РАБОТЫ (дизайн 8): из деталей и из завершившегося
    // терминала они сворачивали бы работу, на которую пользователь не смотрит.
    if (focus === 'sessions' && (key.leftArrow || input === 'h')) {
      onCollapse?.();
      return;
    }

    if (focus === 'sessions' && (key.rightArrow || input === 'l')) {
      onExpand?.();
      return;
    }

    if (input === 'n') {
      if (!newSessionEnabled) return;
      onNewSession?.();
      setFocus('terminal');
      return;
    }

    if (key.return) {
      if (focus === 'sessions' && sessionCount > 0) {
        onOpen?.(selectedSession);
        if (focusTerminalOnOpen) setFocus('terminal');
      }
      return;
    }

    const step = key.downArrow || input === 'j' ? 1 : key.upArrow || input === 'k' ? -1 : 0;
    if (step === 0) return;

    if (focus === 'sessions') {
      setSelectedSession((at) => clamp(at + step, sessionCount));
    } else if (focus === 'subsessions') {
      setSelectedSubsession((at) => clamp(at + step, getSubsessionCount()));
    }
  });

  return { focus, selectedSession, selectedSubsession, setFocus, select: setSelectedSession };
}
