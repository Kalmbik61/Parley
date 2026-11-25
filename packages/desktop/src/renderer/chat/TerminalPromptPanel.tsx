/**
 * Панель «вопрос терминала» над полем ввода вида «Chat» (план 2026-11-18, задача 2): агент ждёт человека в
 * терминале — панель показывает нижние строки его экрана и принимает ответ клавишами и текстом, вкладку
 * переключать не нужно. Экран читается запросом `pty.screenText`, ответ идёт существующим `pty.input`.
 * Строки экрана — данные терминала: рисуются только текстом, в журнал и `console` не идут.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { readCodexFollowUpScreen } from '@parley/core/codex-follow-up-screen';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { updateTab } from '../layout/tree.js';
import { Button } from '../ui/button.js';
import { WaitingBanner } from './WaitingBanner.js';
import { PROMPT_AFTER_KEY_MS, PROMPT_POLL_MS, keyData, promptLines } from './terminal-prompt.js';

export interface TerminalPromptPanelProps {
  workKey: string;
  tabId: string;
  sessionRef: SessionRef;
  bridge: ParleyBridge;
  /** Заголовок: причина ожидания. */
  title: string;
  /** Панель видна и вкладка активна: только тогда идёт опрос и принимаются клавиши. */
  active: boolean;
}

export function TerminalPromptPanel({ workKey, tabId, sessionRef, bridge, title, active }: TerminalPromptPanelProps): JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');
  const screenRef = useRef<HTMLPreElement>(null);
  // Внеочередное чтение после нажатия: живёт, пока идёт опрос; `null` — панель неактивна.
  const refreshRef = useRef<(() => void) | null>(null);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const { projectPath, workId, sessionId } = sessionRef;

  useEffect(() => {
    if (!active) return undefined;
    const ref: SessionRef = { projectPath, workId, sessionId };
    const timers = timersRef.current;
    let cancelled = false;
    // Ответы могут прийти не по порядку: применяется только самый новый из уже спрошенных.
    let asked = 0;
    let applied = 0;
    const read = (): void => {
      asked += 1;
      const mine = asked;
      bridge.call('pty.screenText', { ref }).then(
        (result) => {
          if (cancelled || mine < applied) return;
          applied = mine;
          setLines(result.lines);
        },
        () => {
          // Отказ — прошлые строки остаются, повтор по расписанию.
        },
      );
    };
    refreshRef.current = () => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        read();
      }, PROMPT_AFTER_KEY_MS);
      timers.add(timer);
    };
    read();
    const poll = setInterval(read, PROMPT_POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = null;
      clearInterval(poll);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, [active, bridge, projectPath, workId, sessionId]);

  const shown = promptLines(lines);
  const screenKey = shown.join('\n');
  // После каждого обновления экран стоит на последней строке: вопрос и варианты — внизу блока.
  useEffect(() => {
    const el = screenRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [screenKey]);

  const send = (data: string): void => {
    if (!active) return;
    bridge.notify('pty.input', { ref: sessionRef, data });
    refreshRef.current?.();
  };

  const submitText = (): void => {
    if (!active) return;
    const value = text;
    setText('');
    if (value === '') {
      send('\r');
      return;
    }
    send(value);
    // Enter отдельным сообщением с паузой: быстрый текст с Enter Codex принимает за вставку и не отправляет.
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      send('\r');
    }, PROMPT_AFTER_KEY_MS);
    timersRef.current.add(timer);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Только нажатия на самой панели: кнопки и поле ввода живут своей жизнью.
    if (event.target !== event.currentTarget || !active) return;
    const data = keyData(event);
    if (data === null) return;
    event.preventDefault();
    event.stopPropagation();
    send(data);
  };

  const openTerminal = (): void => {
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { view: 'terminal' }));
  };

  if (readCodexFollowUpScreen(lines) !== null) return <WaitingBanner workKey={workKey} tabId={tabId} text={title} />;

  const P = S.chat.terminalPrompt;
  return (
    <div
      data-testid="chat-terminal-prompt"
      role="group"
      aria-label={title}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      className="mx-3 mb-2 flex min-h-0 shrink-0 flex-col gap-1.5 rounded-lg border border-border bg-foreground/5 p-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="chat-terminal-prompt-title">{title}</span>
        <span className="shrink-0 text-muted-foreground" data-testid="chat-terminal-prompt-hint">{focused ? P.keysHint : P.focusHint}</span>
        <Button type="button" size="xs" variant="outline" data-testid="chat-terminal-prompt-open" onClick={openTerminal} className="shrink-0">
          {P.open}
        </Button>
      </div>
      <pre
        ref={screenRef}
        data-testid="chat-terminal-prompt-screen"
        aria-live="polite"
        className="max-h-[40vh] min-h-0 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-snug"
      >
        {shown.length === 0 ? <span className="text-muted-foreground">{P.empty}</span> : screenKey}
      </pre>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button type="button" size="xs" variant="outline" aria-label={P.up} data-testid="chat-terminal-prompt-up" onClick={() => send('\u001b[A')}>
          ↑
        </Button>
        <Button type="button" size="xs" variant="outline" aria-label={P.down} data-testid="chat-terminal-prompt-down" onClick={() => send('\u001b[B')}>
          ↓
        </Button>
        <Button type="button" size="xs" variant="outline" data-testid="chat-terminal-prompt-enter" onClick={() => send('\r')}>
          {P.enter}
        </Button>
        <Button type="button" size="xs" variant="outline" data-testid="chat-terminal-prompt-escape" onClick={() => send('\u001b')}>
          {P.escape}
        </Button>
        <input
          type="text"
          value={text}
          aria-label={P.typeAnswer}
          placeholder={P.typeAnswer}
          data-testid="chat-terminal-prompt-input"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Поле — своя жизнь: клавиши в терминал не идут, Enter отправляет текст.
            event.stopPropagation();
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submitText();
            }
          }}
          className="h-6 min-w-24 flex-1 rounded border border-border bg-background px-2 text-xs"
        />
        <Button type="button" size="xs" variant="outline" data-testid="chat-terminal-prompt-send" onClick={submitText}>
          {P.send}
        </Button>
      </div>
    </div>
  );
}
