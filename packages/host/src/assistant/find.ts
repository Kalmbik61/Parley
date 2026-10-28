/**
 * Поиск помощника по словам человека (спека рук помощника, 5.1): работа, проект, комната или сессия находятся по
 * названию, имени папки, ярлыку, роли, `task` и `summary`. Совпадение — подстрока без учёта регистра; если прямых
 * совпадений нет, вторая попытка идёт по «звучанию» (`soundKey`), чтобы «Сканум» находил `scanum`. Чистая функция над
 * снимком работ.
 */

import {
  briefLine,
  projectName,
  targetsOf,
  type AssistantTarget,
  type OverviewSource,
} from './overview.js';

/** Находок в ответе не больше: дальше модель уточняет запрос (спека 5.1). */
const FIND_LIMIT = 20;
/** Сколько знаков совпавшего `task` или `summary` показывается рядом с находкой. */
const NOTE_LENGTH = 120;

const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * «Звучание» строки: нижний регистр, `ё` как `е`, кириллица латиницей, только `[a-z0-9]`, затем сведение близких букв
 * (`ph` → `f`, `x` → `ks`, `c`/`q` → `k`, `w` → `v`, `y` → `i`) и одна буква вместо подряд идущих одинаковых.
 */
export function soundKey(text: string): string {
  const latin = [...text.toLowerCase().replace(/ё/g, 'е')] // cyrillic-ok: ё и е в транслите для поиска по звучанию
    .map((char) => CYRILLIC[char] ?? char)
    .join('');
  return latin
    .replace(/[^a-z0-9]/g, '')
    .replace(/ph/g, 'f')
    .replace(/x/g, 'ks')
    .replace(/[cq]/g, 'k')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i')
    .replace(/([a-z])\1+/g, '$1');
}

type FieldKind = 'name' | 'project' | 'role' | 'task' | 'summary';
interface Field {
  kind: FieldKind;
  text: string;
}

/** Поля цели, по которым идёт поиск; пустые `task` и `summary` не в счёт. */
function fieldsOf(source: OverviewSource, target: AssistantTarget): Field[] {
  const fields: Field[] = [{ kind: 'name', text: target.name }];
  if (target.kind === 'work')
    fields.push({ kind: 'project', text: projectName(target.projectPath) });
  if (target.kind !== 'session') return fields;
  const entry = source.entries.find(
    (item) => item.projectPath === target.ref.projectPath && item.map.work.id === target.ref.workId,
  );
  const session = entry?.map.sessions.find((item) => item.id === target.ref.sessionId);
  if (session === undefined) return fields;
  if (session.role?.name !== undefined) fields.push({ kind: 'role', text: session.role.name });
  if (typeof session.task === 'string' && session.task.trim() !== '')
    fields.push({ kind: 'task', text: session.task });
  if (typeof session.summary === 'string' && session.summary.trim() !== '')
    fields.push({ kind: 'summary', text: session.summary });
  return fields;
}

/**
 * Ответ `parley_find`: до 20 строк обзора с id, точные совпадения имени (у работы ещё и имени папки) — первыми, остальные
 * в порядке `targetsOf`. Закрытые сессии, архивные комнаты и работы ищутся только с `includeClosed`. Пустой `query`
 * отсекает вызывающий: здесь он совпал бы со всем.
 */
export function findText(
  source: OverviewSource,
  query: string,
  options: { includeClosed: boolean },
): string {
  const wanted = query.trim();
  const lower = wanted.toLowerCase();
  const targets = targetsOf(source, { hidden: options.includeClosed });
  const search = (
    matches: (text: string) => boolean,
  ): Array<{ target: AssistantTarget; fields: Field[] }> =>
    targets.flatMap((target) => {
      const fields = fieldsOf(source, target).filter((field) => matches(field.text));
      return fields.length === 0 ? [] : [{ target, fields }];
    });
  let found = search((text) => text.toLowerCase().includes(lower));
  const sound = soundKey(wanted);
  if (found.length === 0 && sound !== '') found = search((text) => soundKey(text).includes(sound));
  if (found.length === 0) return `Nothing found for "${wanted}".`;
  const isExact = ({ fields }: (typeof found)[number]): boolean =>
    fields.some(
      (field) =>
        (field.kind === 'name' || field.kind === 'project') && field.text.toLowerCase() === lower,
    );
  const ordered = [...found.filter(isExact), ...found.filter((item) => !isExact(item))];
  const lines = ordered.slice(0, FIND_LIMIT).map(({ target, fields }) => {
    const note =
      fields.find((field) => field.kind === 'task') ??
      fields.find((field) => field.kind === 'summary');
    const brief = briefLine(source, target);
    return note === undefined
      ? brief
      : `${brief} — matched ${note.kind}: ${note.text.replace(/\s+/g, ' ').trim().slice(0, NOTE_LENGTH)}`;
  });
  if (ordered.length > FIND_LIMIT)
    lines.push(`…and ${ordered.length - FIND_LIMIT} more; say more precisely.`);
  return lines.join('\n');
}
