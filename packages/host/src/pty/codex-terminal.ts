/**
 * Состояние сессии Codex по потоку его терминала (спека комнат Organic, 3.6, «Состояние без хуков»).
 * У Claude Code состояние приходит хуками, а хуки Codex харнесс не включает: им нужно ревью
 * человека, и доверия себе харнесс не выдаёт. Остаётся то, что Codex сам пишет в терминал, когда
 * его запускают с нашими `-c` (`core/providers.ts`, `CODEX_HARNAS_FLAGS`):
 * - заголовок окна, OSC 0: `tui.terminal_title=["spinner","status","session-id"]` — кадр спиннера,
 *   пока агент работает, слова `Working` и `Ready`, а когда Codex ждёт ответа человека — заголовок
 *   `[ ! ] Action Required`;
 * - уведомления, OSC 9 (`tui.notifications`, `tui.notification_method="osc9"`,
 *   `tui.notification_condition="always"`): `approval-requested` и `agent-turn-complete`.
 *
 * Строки заголовка и уведомлений — не публичный интерфейс Codex: они выведены из документации и
 * исходников 0.159 (исследование `codex-research.md`, разделы 3.3 и 14), на живом Codex не сверены.
 * Поэтому здесь есть честное «неизвестно» — заголовок или уведомление, которых не узнали, не
 * становятся ни «работает», ни «готов». Разбор — тут, в хосте, у того, кто держит pty, а не в окне: у
 * сессии есть состояние и при закрытой панели.
 *
 * Поток разбирается с буфером на границах чанков: последовательность OSC может прийти разрезанной где
 * угодно, в том числе между `ESC` и `\` терминатора.
 */

/** Что сказал терминал Codex. Каждое значение — отдельный сигнал, а не итоговое состояние сессии. */
export type CodexSignal =
  /** Спиннер или слово `Working` в заголовке: идёт ход. */
  | { kind: 'working' }
  /** Слово `Ready` в заголовке: агент у приглашения. */
  | { kind: 'ready' }
  /** Человеку нужно ответить: заголовок `Action Required` или уведомление об одобрении. */
  | { kind: 'needs-you'; reason: 'action-required' | 'approval-requested' }
  /** Уведомление `agent-turn-complete` без текста ответа: ход закончен. */
  | { kind: 'turn-complete' }
  /** Заголовок или уведомление, которых не узнали: состояния не меняют. */
  | { kind: 'unknown'; source: 'title' | 'notification' };

const ESC = '\x1b';
const BEL = '\x07';
/** C1-терминатор строки (`ST`, 8-битная форма). */
const ST_C1 = '\x9c';
/** `CAN` и `SUB` обрывают любую управляющую последовательность (ECMA-48). */
const CAN = '\x18';
const SUB = '\x1a';

/**
 * Длиннее этой последовательности OSC не копятся: заголовок — десятки знаков, уведомление — до
 * двухсот знаков ответа или команды одобрения. Мусор без терминатора не должен расти в памяти вечно.
 */
export const MAX_OSC_LENGTH = 8192;

/** Кадры спиннера Codex — символы Брайля; первый знак заголовка из этого блока — ход идёт. */
const BRAILLE_PATTERNS = /^[\s]*[⠀-⣿]/;
const ACTION_REQUIRED = /\baction required\b/i;
const WORKING_WORD = /\bWorking\b/;
const READY_WORD = /\bReady\b/;

/**
 * Заголовок окна Codex → сигнал. Порядок проверок важен: `Action Required` сильнее всего, а спиннер
 * сильнее слов. `Thinking`, `Waiting`, `Starting` — слова того же элемента `status`, но что они значат
 * для состояния, в исследовании не сказано, и они остаются «неизвестными»: ход в любом случае
 * показывает спиннер.
 */
export function classifyTitle(title: string): CodexSignal {
  if (ACTION_REQUIRED.test(title)) return { kind: 'needs-you', reason: 'action-required' };
  if (BRAILLE_PATTERNS.test(title) || WORKING_WORD.test(title)) return { kind: 'working' };
  if (READY_WORD.test(title)) return { kind: 'ready' };
  return { kind: 'unknown', source: 'title' };
}

/**
 * Уведомление OSC 9 → сигнал. Текст не типизирован (тип уведомления Codex в OSC 9 не пишет), поэтому
 * классификация — по началу строки, и узкая: `Approval requested: <команда>` и `Codex wants to edit
 * <файл>` — одобрение; `Agent turn complete` без ответа — конец хода. С ответом агента вместо этой
 * фразы (`agent-turn-complete` кладёт в текст до двухсот знаков ответа) уведомление не узнаётся:
 * конец хода тогда подтверждают заголовок `Ready`, `notify` и `task_complete` в логе.
 */
export function classifyNotification(text: string): CodexSignal {
  const trimmed = text.trim();
  if (/^Approval requested:/.test(trimmed) || /^Codex wants to edit\b/.test(trimmed)) {
    return { kind: 'needs-you', reason: 'approval-requested' };
  }
  if (trimmed === 'Agent turn complete') return { kind: 'turn-complete' };
  return { kind: 'unknown', source: 'notification' };
}

/** Тело OSC (`Ps;Pt`) → сигнал; `null` — не заголовок и не уведомление (гиперссылки, метки, буфер). */
function signalOfOsc(body: string): CodexSignal | null {
  const semicolon = body.indexOf(';');
  if (semicolon === -1) return null;
  const command = body.slice(0, semicolon);
  const text = body.slice(semicolon + 1);
  // OSC 0 — значок и заголовок вместе, OSC 2 — заголовок; Codex пишет `0`.
  if (command === '0' || command === '2') return classifyTitle(text);
  if (command === '9') return classifyNotification(text);
  return null;
}

export interface CodexTerminalParser {
  /** Разбирает следующий кусок потока; сигналы — в порядке появления. Не бросает. */
  feed(chunk: string): CodexSignal[];
}

export function createCodexTerminalParser(): CodexTerminalParser {
  /** Начало OSC, оборванное границей чанка (или одинокий `ESC` на конце): продолжится в следующем. */
  let pending = '';

  return {
    feed(chunk) {
      const data = pending + chunk;
      pending = '';
      const signals: CodexSignal[] = [];
      let at = 0;

      scan: while (at < data.length) {
        const start = data.indexOf(`${ESC}]`, at);
        if (start === -1) {
          // Одинокий `ESC` на конце может оказаться началом `ESC ]`, разрезанного между чанками.
          if (data.endsWith(ESC)) pending = ESC;
          break;
        }

        const bodyStart = start + 2;
        for (let index = bodyStart; index < data.length; index += 1) {
          const char = data[index];
          if (char === BEL || char === ST_C1) {
            const signal = signalOfOsc(data.slice(bodyStart, index));
            if (signal !== null) signals.push(signal);
            at = index + 1;
            continue scan;
          }
          if (char === ESC) {
            // `ESC \` — терминатор; другой `ESC` обрывает OSC, и на нём начинается новая последовательность.
            if (index + 1 >= data.length) break;
            if (data[index + 1] === '\\') {
              const signal = signalOfOsc(data.slice(bodyStart, index));
              if (signal !== null) signals.push(signal);
              at = index + 2;
              continue scan;
            }
            at = index;
            continue scan;
          }
          if (char === CAN || char === SUB) {
            at = index + 1;
            continue scan;
          }
        }

        // Терминатора в этом куске нет: хвост ждёт следующего, но без роста до бесконечности.
        const tail = data.slice(start);
        if (tail.length <= MAX_OSC_LENGTH) pending = tail;
        break;
      }

      return signals;
    },
  };
}
