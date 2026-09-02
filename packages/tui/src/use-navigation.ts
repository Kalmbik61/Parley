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

    if (input === 'n') {
      onNewSession?.();
      setFocus('terminal');
      return;
    }

    if (key.return) {
      if (focus === 'sessions' && sessionCount > 0) {
        onOpen?.(selectedSession);
        setFocus('terminal');
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

  return { focus, selectedSession, selectedSubsession, setFocus };
}
