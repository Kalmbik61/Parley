/**
 * Каталог моделей для окна и MCP: значение для флага `--model`, подпись для человека и уровни effort
 * каждой модели. Списки Claude Code и GLM взяты из открытой документации провайдера. Каталог Codex
 * даёт сам CLI: хост спрашивает его командой `codex debug models` (спека нормалайзера модели и effort,
 * 5.2), а `CODEX_MODELS` здесь — запасной снимок того же вывода на случай, когда проба не удалась.
 * Порядок — как в источнике.
 *
 * «По умолчанию» в списке нет. Это не модель, а отсутствие выбора: без флага CLI берёт свою модель
 * по умолчанию. Документация Claude Code сама называет `default` особым значением, которое лишь
 * сбрасывает выбор, а не именем модели, — окно показывает «по умолчанию» отдельной строкой и
 * ничего не передаёт хосту. Так же и с effort: «Default» — это отсутствие флага, а не уровень.
 *
 * Как обновлять. Вышла модель, которой в списке ещё нет, — дописать её сюда по источнику, источник и
 * дату проверки поправить тут же. Запасной список Codex снимают заново с вывода `codex debug models`:
 * список там меняется за дни. До обновления харнесса человек дополняет список у себя в
 * `providers.json` (поле `models`, уровни — полем `efforts`). Полные имена версий (`claude-opus-5-5`,
 * `claude-fable-5`) в список Claude Code не входят: алиасы сами указывают на актуальную версию и не
 * стареют, а закреплённую версию человек добавит записью в `providers.json`.
 */

/** Уровень effort модели: `id` — значение флага, `label` — подпись для человека. */
export interface EffortOption {
  /** Значение флага: `--effort <id>` / `model_reasoning_effort="<id>"`. */
  id: string;
  label: string;
  description?: string;
}

/** Модель в списке окна: `id` — значение `--model`, `label` — подпись для человека. */
export interface ModelOption {
  id: string;
  label: string;
  /**
   * Уровни этой модели по порядку. `null` — у модели effort нет (Haiku).
   * Поля нет — каталог не знает (свой список в providers.json): действует правило провайдера.
   */
  efforts?: EffortOption[] | null;
}

/** Подписи уровней (спека нормалайзера, 5.1). `Map`, а не объект: id вроде `constructor` — не ключ прототипа. */
const EFFORT_LABELS: ReadonlyMap<string, string> = new Map([
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
  ['ultra', 'Ultra'],
  ['minimal', 'Minimal'],
  ['none', 'None'],
]);

/** Подпись уровня для человека: известный — по таблице, незнакомый id — с заглавной буквы. */
export function effortLabel(id: string): string {
  return EFFORT_LABELS.get(id) ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** Уровни без описаний — с подписями по `effortLabel`. */
const levels = (...ids: string[]): EffortOption[] => ids.map((id) => ({ id, label: effortLabel(id) }));

/**
 * Уровни Claude Code — `--effort` принимает `low, medium, high, xhigh, max` (code.claude.com/docs/en/model-config,
 * проверено 2026-10-06). Описаний у них нет.
 */
export const CLAUDE_EFFORTS: EffortOption[] = levels('low', 'medium', 'high', 'xhigh', 'max');

/**
 * Прежние три уровня: правило провайдера, чей каталог уровней не знает, — свой список моделей в
 * `providers.json` без `efforts` или провайдер без списка вовсе (`effortsFor`).
 */
export const LEGACY_EFFORTS: EffortOption[] = levels('low', 'medium', 'high');

/**
 * Claude Code. Источник — https://code.claude.com/docs/en/model-config (проверено 2026-09-29,
 * 17:33 GMT): таблица «Model aliases» — алиасы, которые принимают `--model` и настройка `model`, и
 * раздел про `opusplan`, который называет и `opusplan[1m]` (для него прямо сказано: флаг `--model`
 * или настройка `model`). Порядок таблицы сохранён, `opusplan[1m]` стоит следом за `opusplan`,
 * особое значение `default` пропущено (см. выше). Строка `--model` в
 * https://code.claude.com/docs/en/cli-reference называет из них `sonnet`, `opus`, `haiku` и
 * `fable`. Подписи — по имени алиаса; версию, на которую он сейчас указывает, они не называют:
 * она зависит от провайдера и от версии Claude Code. `fable[1m]` в таблице нет: документация
 * называет его лишь значением, на которое переписывает старый сохранённый выбор, и сама говорит,
 * что у Fable окно 1M и так есть, а `[1m]` выбирать не нужно.
 *
 * Уровни — по той же странице (проверено 2026-10-06): у всех алиасов, кроме `haiku`, пять уровней
 * `CLAUDE_EFFORTS`; уровень выше поддерживаемого моделью Claude Code сам опускает до ближайшего ниже. У
 * Haiku effort нет: `--effort` Claude Code молча отбрасывает (спека нормалайзера, раздел 3, п. 1–2).
 */
export const CLAUDE_MODELS: readonly ModelOption[] = [
  { id: 'best', label: 'Best', efforts: CLAUDE_EFFORTS },
  { id: 'fable', label: 'Fable', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', label: 'Sonnet', efforts: CLAUDE_EFFORTS },
  { id: 'opus', label: 'Opus', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', label: 'Haiku', efforts: null },
  { id: 'sonnet[1m]', label: 'Sonnet (1M context)', efforts: CLAUDE_EFFORTS },
  { id: 'opus[1m]', label: 'Opus (1M context)', efforts: CLAUDE_EFFORTS },
  { id: 'opusplan', label: 'Opus Plan', efforts: CLAUDE_EFFORTS },
  { id: 'opusplan[1m]', label: 'Opus Plan (1M context)', efforts: CLAUDE_EFFORTS },
];

/** Уровень Codex: описание — из каталога самого CLI, как есть. */
const codexLevel = (id: string, description: string): EffortOption => ({
  id,
  label: effortLabel(id),
  description,
});

const CODEX_EFFORTS: EffortOption[] = [
  codexLevel('low', 'Fast responses with lighter reasoning'),
  codexLevel('medium', 'Balances speed and reasoning depth for everyday tasks'),
  codexLevel('high', 'Greater reasoning depth for complex problems'),
  codexLevel('xhigh', 'Extra high reasoning depth for complex problems'),
  codexLevel('max', 'Maximum reasoning depth for the hardest problems'),
];

const CODEX_ULTRA_EFFORTS: EffortOption[] = [
  ...CODEX_EFFORTS,
  codexLevel('ultra', 'Maximum reasoning with automatic task delegation'),
];

/**
 * Codex CLI — запасной список. Живой каталог аккаунта хост берёт у самого CLI (`codex debug models`) и,
 * пока проба удаётся, отдаёт окну его. Здесь — снимок того же вывода от 2026-10-06 (Codex 0.160.0;
 * спека нормалайзера, раздел 3, п. 11–12): только видимые модели (`visibility: "list"`), в порядке
 * `priority`, с уровнями (`supported_reasoning_levels`) и их описаниями. Скрытые (`gpt-5.5` и служебные)
 * в список не входят. Подписи — `display_name` каталога («GPT-6.1-Sol»): окно выглядит одинаково и с живым
 * каталогом, и без него.
 */
export const CODEX_MODELS: readonly ModelOption[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_EFFORTS },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: CODEX_EFFORTS },
];

/**
 * Official Z.ai Claude Code integration (2026-10-03): https://docs.z.ai/devpack/tool/claude.
 * Уровни — пять уровней Claude Code: GLM-сессию ведёт сам Claude Code, он шлёт Z.ai effort любого уровня
 * вплоть до `max`, а Z.ai его учитывает (спека нормалайзера, раздел 3, п. 8–9).
 */
export const GLM_MODELS: readonly ModelOption[] = [
  { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)', efforts: CLAUDE_EFFORTS },
  { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M context)', efforts: CLAUDE_EFFORTS },
];
