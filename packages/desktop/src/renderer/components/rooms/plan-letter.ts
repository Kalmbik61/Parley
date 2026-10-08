/**
 * Письма плана от `parley` в ленте комнаты — Markdown для человека. Хост собирает их простым текстом
 * (`core/src/work/plan-effects.ts`): заголовок «Accepted plan pl-01, revision 0, item 6: …», строки «Scope:»,
 * «Criteria:», «Evidence:», и в конце — инструкция агенту. В ленте это сплошной текст, где задача, критерии и
 * служебная фраза не отделены друг от друга. Окно узнаёт письмо по его заголовку и последней фразе и раскладывает
 * его по разделам: название пункта жирным, разделы с подписью, критерии списком, инструкция — «Next:» с инструментами
 * в `code`. Пути в тексте делает кодом плагин ленты (`remarkCodePaths`, `room-remark.ts`).
 *
 * Сам текст письма не меняется: его же читает агент, а хост сверяет текст письма в очереди с тем, что собрал бы заново
 * (`currentPlanEffect`), — новый формат в core отменил бы письма планов, уже идущих при обновлении. Слова письма в
 * ленте те же, меняются только раскладка и выделение: человек видит то, что прочтёт агент. Письмо, которое не
 * совпало с форматом целиком, показывается как есть.
 *
 * Фразы ниже — копии строк `plan-effects.ts`: тест (`plan-letter.test.ts`) сверяет их с исходником core.
 */

export const PLAN_LETTER_TAILS = {
  ready: 'Perform this accepted assignment; use plan_update and plan_submit with this exact planId/rev/item. A skill named in scope is guidance, not automatic loading.',
  verify: 'Independently inspect the result and call plan_verify with this exact planId/rev/item.',
  returned: 'Address this note, then call plan_submit with this exact planId/rev/item.',
  blocked: 'Bring an amended decision if this assignment must change.',
  mode: 'Bring a plan matching the current mode before proceeding.',
  completionReturned: 'Revise the completion summary or propose an amended decision.',
} as const;

const HEADER = /^Accepted plan (pl-\d+), revision (\d+), item (\d+): (.*)$/;
const COMPLETING = /^(Plan pl-\d+, revision \d+ is ready for human completion\.) (Collect remaining work through backlog_list\/backlog_suggest, then call propose_completion with this exact planId\/rev and a summary\.)$/;
const COMPLETION_RETURNED = /^(Plan pl-\d+, revision \d+:) ([\s\S]*)$/;
const MODE = /^(Room mode changed\.) ([\s\S]*)$/;
const TOOLS = /\b(plan_update|plan_submit|plan_verify|propose_completion|propose_decision|backlog_list|backlog_suggest)\b/g;
/** Строка критерия, которая уже пункт списка: «- …», «* …», «1. …». */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Инструкция Parley агенту: «Next:», инструменты — кодом. */
const next = (tail: string): string => `**Next:** ${tail.replace(TOOLS, '`$1`')}`;
/** Подпись раздела над его текстом. */
const section = (label: string, body: string): string => `**${label}**\n${body.trim()}`;
/** Название пункта жирным: звёздочка в нём закрыла бы выделение раньше времени. */
const strong = (text: string): string => `**${text.replace(/\*/g, '\\*')}**`;

function criteriaList(criteria: string): string {
  return criteria
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (LIST_ITEM.test(line) ? line : `- ${line}`))
    .join('\n');
}

/** Отрезает последнюю строку письма, если это известная инструкция; иначе `null`. */
function splitTail(text: string, tail: string): string | null {
  const suffix = `\n${tail}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : null;
}

/** «Scope:\n…[\nCriteria:\n…]» → разделы; `null`, если письмо не того вида. */
function scopeSections(body: string): string[] | null {
  if (!body.startsWith('Scope:\n') && body !== 'Scope:') return null;
  const rest = body.slice('Scope:\n'.length);
  const at = rest.indexOf('\nCriteria:\n');
  if (at < 0) return [section('Scope', rest)];
  return [section('Scope', rest.slice(0, at)), section('Criteria', criteriaList(rest.slice(at + '\nCriteria:\n'.length)))];
}

function itemLetter(header: RegExpExecArray, text: string): string | null {
  const [line, planId, rev, item, title = ''] = header;
  const head = [title.trim() === '' ? null : strong(title.trim()), `Accepted plan ${planId}, revision ${rev}, item ${item}`]
    .filter((part) => part !== null)
    .join('\n');
  const body = text.slice(line.length + 1);

  const blocked = splitTail(body, PLAN_LETTER_TAILS.blocked);
  if (blocked !== null && blocked.startsWith('Blocked: ')) {
    return [head, section('Blocked', blocked.slice('Blocked: '.length)), next(PLAN_LETTER_TAILS.blocked)].join('\n\n');
  }

  const ready = splitTail(body, PLAN_LETTER_TAILS.ready);
  if (ready !== null) {
    const sections = scopeSections(ready);
    return sections === null ? null : [head, ...sections, next(PLAN_LETTER_TAILS.ready)].join('\n\n');
  }

  const verify = splitTail(body, PLAN_LETTER_TAILS.verify);
  if (verify !== null) {
    const at = verify.indexOf('\nEvidence:\n');
    if (at < 0) return null;
    const sections = scopeSections(verify.slice(0, at));
    const evidence = verify.slice(at + '\nEvidence:\n'.length);
    if (sections === null) return null;
    return [head, ...sections, ...(evidence.trim() === '' ? [] : [section('Evidence', evidence)]), next(PLAN_LETTER_TAILS.verify)].join('\n\n');
  }

  const returned = splitTail(body, PLAN_LETTER_TAILS.returned);
  if (returned !== null) {
    const at = returned.indexOf('\nReturned for rework: ');
    if (at < 0) return null;
    const sections = scopeSections(returned.slice(0, at));
    const note = returned.slice(at + '\nReturned for rework: '.length);
    if (sections === null) return null;
    return [head, ...sections, section('Returned for rework', note), next(PLAN_LETTER_TAILS.returned)].join('\n\n');
  }
  return null;
}

/**
 * Markdown письма плана от `parley` или `null`, если текст — не письмо плана (тогда лента показывает его как есть).
 * Разбирается только целиком совпавший формат: заголовок, разделы и последняя фраза — ровно те, что пишет хост.
 */
export function planLetterMarkdown(text: string): string | null {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const header = HEADER.exec(firstLine);
  if (header !== null && text.length > firstLine.length) return itemLetter(header, text);

  const completing = COMPLETING.exec(text);
  if (completing !== null) return [`**${completing[1]}**`, next(completing[2] ?? '')].join('\n\n');

  const mode = splitTail(text, PLAN_LETTER_TAILS.mode);
  const modeHead = mode === null ? null : MODE.exec(mode);
  if (modeHead !== null) return [`**${modeHead[1]}** ${modeHead[2]}`, next(PLAN_LETTER_TAILS.mode)].join('\n\n');

  const returned = splitTail(text, PLAN_LETTER_TAILS.completionReturned);
  const returnedHead = returned === null ? null : COMPLETION_RETURNED.exec(returned);
  if (returnedHead !== null) return [`**${returnedHead[1]}** ${returnedHead[2]}`, next(PLAN_LETTER_TAILS.completionReturned)].join('\n\n');
  return null;
}
