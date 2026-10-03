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
 * источник и дату проверки поправить тут же. Страницу моделей Codex перед правкой снимают заново:
 * список там меняется за дни. До обновления харнесса человек дополняет список у себя в
 * `providers.json` (поле `models`). Полные имена версий (`claude-opus-5-5`, `claude-fable-5`) в
 * список Claude Code не входят: алиасы сами указывают на актуальную версию и не стареют, а
 * закреплённую версию человек добавит записью в `providers.json`.
 */

/** Модель в списке окна: `id` — значение `--model`, `label` — подпись для человека. */
export interface ModelOption {
  id: string;
  label: string;
}

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
  { id: 'opusplan[1m]', label: 'Opus Plan (1M context)' },
];

/**
 * Codex CLI. Источники (проверено 2026-09-29, 17:31–17:33 GMT):
 * - https://developers.openai.com/codex/models (редирект на learn.chatgpt.com/docs/models), раздел
 *   «Recommended models»: у каждой рекомендованной модели карточка с командой запуска
 *   `codex -m <id>` — `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`; порядок карточек сохранён,
 *   подписи — как в тексте страницы («GPT-6.1 Sol», «GPT-6 Luna»; для Astra — как в названии статьи
 *   документации «GPT-6 Astra»). Та же страница называет `gpt-6-sol` предыдущей Sol и перечисляет
 *   её среди моделей, доступных в Codex, поэтому она стоит следом за 6.1;
 * - https://developers.openai.com/codex/cli/reference — флаг `--model, -m` с примером `gpt-6.1-sol`;
 * - каталог самого CLI в открытом репозитории openai/codex, `codex-rs/models-manager/models.json`
 *   (коммит b1e72963c3, 2026-09-29): те же четыре модели, все показываются в выборе `/model`;
 *   `gpt-6-sol` описана там как модель предыдущего поколения. Приоритеты каталога ставят 6.1 Sol
 *   первой, но порядок здесь берётся у страницы документации.
 * `gpt-6-sol` оставлена не зря: 6.1 Sol доступна не везде (страница: на запуске в Free и Go её нет,
 * в Enterprise и Edu она выключена, пока администратор не включит), а 6 Sol документация не снимала.
 * Прежнее поколение (`gpt-5.6-*`) документация оставляет лишь на время выкатки, а `gpt-5.5`,
 * `gpt-5.4` и `gpt-5.4-mini` снимает с входа через ChatGPT (`gpt-5.5` — 2026-10-14, остальные уже
 * сняты): в список они не входят.
 */
export const CODEX_MODELS: readonly ModelOption[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
];

/** Official Z.ai Claude Code integration (2026-10-03): https://docs.z.ai/devpack/tool/claude. */
export const GLM_MODELS: readonly ModelOption[] = [
  { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)' },
  { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M context)' },
];
