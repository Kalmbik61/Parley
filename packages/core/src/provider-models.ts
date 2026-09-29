/**
 * Списки моделей для окна: значение для флага `--model` и подпись для человека. Берутся только из
 * открытой документации самого провайдера — ничего не выдумано и не подсмотрено у настоящего CLI:
 * ради списка `claude` и `codex` не запускаются (даже `codex debug models`, который печатает свой
 * каталог). Порядок — как в источнике.
 *
 * «По умолчанию» в списке нет. Это не модель, а отсутствие выбора: без флага CLI берёт свою модель
 * по умолчанию. Документация Claude Code сама называет `default` особым значением, которое лишь
 * сбрасывает выбор, а не именем модели, — окно показывает «по умолчанию» отдельной строкой и
 * ничего не передаёт хосту.
 *
 * Как обновлять. Вышла модель, которой в списке ещё нет, — дописать её сюда по документации,
 * источник и дату проверки поправить тут же. До обновления харнесса человек дополняет список у
 * себя в `providers.json` (поле `models`). Полные имена версий (`claude-opus-5-5`,
 * `claude-fable-5`) в список Claude Code не входят: алиасы сами указывают на актуальную версию и
 * не стареют, а закреплённую версию человек добавит записью в `providers.json`.
 */

/** Модель в списке окна: `id` — значение `--model`, `label` — подпись для человека. */
export interface ModelOption {
  id: string;
  label: string;
}

/**
 * Claude Code. Источник — https://code.claude.com/docs/en/model-config, раздел «Model aliases»
 * (проверено 2026-09-29): таблица алиасов, которые принимают `--model` и настройка `model`.
 * Порядок таблицы сохранён, особое значение `default` пропущено (см. выше). Строка `--model` в
 * https://code.claude.com/docs/en/cli-reference называет из них `sonnet`, `opus`, `haiku` и
 * `fable`. Подписи — по имени алиаса; версию, на которую он сейчас указывает, они не называют:
 * она зависит от провайдера и от версии Claude Code.
 */
export const CLAUDE_MODELS: readonly ModelOption[] = [
  { id: 'best', label: 'Best' },
  { id: 'fable', label: 'Fable' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet[1m]', label: 'Sonnet (1M context)' },
  { id: 'opus[1m]', label: 'Opus (1M context)' },
  { id: 'opusplan', label: 'Opus Plan' },
];

/**
 * Codex CLI. Источники (проверено 2026-09-29):
 * - https://developers.openai.com/codex/models, раздел «Recommended models»: у каждой модели
 *   карточка с командой запуска `codex -m <id>`; порядок карточек сохранён, подписи — как в тексте
 *   страницы («GPT-6 Sol», «GPT-6 Luna»; для Astra — как в её карточке и в названии статьи
 *   документации);
 * - https://developers.openai.com/codex/cli/reference — флаг `--model, -m` с примером `gpt-6-sol`;
 * - каталог самого CLI в открытом репозитории openai/codex, `codex-rs/models-manager/models.json`
 *   (коммит 694d8d45bd, 2026-09-24): те же три модели с приоритетами 1–3, все показываются в выборе
 *   `/model`.
 * Прежнее поколение (`gpt-5.6-*`) документация оставляет лишь на время выкатки, а `gpt-5.5`,
 * `gpt-5.4` и `gpt-5.4-mini` снимает с входа через ChatGPT (`gpt-5.5` — 2026-10-14, остальные уже
 * сняты): список, стареющий за две недели, окну не нужен.
 */
export const CODEX_MODELS: readonly ModelOption[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
];
