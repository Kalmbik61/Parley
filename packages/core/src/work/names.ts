/**
 * Имена сессий по умолчанию (спека архива комнат и проектов, часть 2, раздел 13). Модуль чистый: ни диска, ни
 * импортов, — поэтому его берёт и окно (`@parley/core/session-names`), и хост, и агенты, а имя сессии зависит только
 * от её номера и везде одинаково.
 */

/**
 * Ярлык быстрой сессии, пока ей не дали имя (5.1). Метка-страж: старые карты на диске хранят её, по значению её
 * узнают `isNewLabel`, хост (автозаголовок) и окно, а агент видит её в брифе и в результатах MCP — поэтому
 * английская. Сессия, заведённая сейчас, получает вместо неё `defaultSessionName`. Живёт здесь, а не в `launch.ts`:
 * `addSession` (`map.ts`) сверяет с ней ярлык, а `launch.ts` сам импортирует `map.ts` — иначе возник бы цикл.
 */
export const NEW_LABEL = 'new session';

/**
 * Имена латиницей: короткие, без повторов, 60 штук. Первыми — имена из разговора с человеком (Ralph, Anatoly, Ruslan,
 * Roman): их он увидит у первых сессий работы; соседние имена начинаются с разных букв.
 * Порядок менять нельзя: имя сессии выводится из номера, и перестановка переименовала бы все сессии, уже лежащие
 * в картах.
 */
export const NAMES: readonly string[] = [
  'Ralph', 'Anatoly', 'Ruslan', 'Bruno', 'Roman', 'Alice', 'Clara', 'Daniel', 'Elena', 'Felix', 'Greta', 'Hugo',
  'Irene', 'Jonas', 'Karl', 'Laura', 'Marco', 'Nina', 'Oscar', 'Paula', 'Quinn', 'Sofia', 'Tomas', 'Ulrich', 'Vera',
  'Walter', 'Xenia', 'Yuri', 'Zoe', 'Boris', 'Carlos', 'Diana', 'Edgar', 'Frank', 'Grace', 'Henry', 'Isaac', 'Jack',
  'Kevin', 'Lucas', 'Maya', 'Nick', 'Olivia', 'Peter', 'Quentin', 'Sam', 'Theo', 'Uma', 'Victor', 'Wendy', 'Xavier',
  'Yara', 'Zach', 'Arthur', 'Bella', 'Cedric', 'Dora', 'Ethan', 'Fred', 'Gina',
];

/** Номер в id сессии вида `s-05`. */
const SESSION_ID = /^s-(\d+)$/;

/**
 * Имя сессии по умолчанию: номер из `s-NN` → `NAMES[(n - 1) % NAMES.length]`. После полного круга к имени
 * добавляется номер круга: `Alice 2`, `Alice 3`, — в пределах работы имя не повторяется. Id не той формы (нет номера)
 * имени не получает: возвращается `NEW_LABEL`, как было до имён.
 */
export function defaultSessionName(id: string): string {
  const match = SESSION_ID.exec(id);
  const number = match === null ? 0 : Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return NEW_LABEL;
  const name = NAMES[(number - 1) % NAMES.length]!;
  const round = Math.floor((number - 1) / NAMES.length) + 1;
  return round === 1 ? name : `${name} ${round}`;
}
