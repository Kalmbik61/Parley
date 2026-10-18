# Parley: соответствие ролей реальным обязанностям

Дата: 2026-10-18. Статус: аудит и предложения для обсуждаемого дизайна. Каталог и поведение приложения не изменены.

## Объём и вывод

Проверены все восемь встроенных ролей из `packages/core/src/roles/builtin.ts`, их сочетание с рецептами комнат и предложенная роль Feature Lead. Импортируемые пользовательские роли Claude/Codex не входят в этот аудит.

Все восемь ролей соответствуют заявленным функциям. Planner, Critic, Executor, Debugger и Researcher — функциональные названия специализаций Parley; сравнение с отраслевыми обязанностями не делает их универсальными названиями должностей. Ограничения на запись файлов — политика Parley, а не утверждение, что реальные специалисты никогда не программируют.

Главные уточнения: различать неуспешную и недоступную проверку у Verifier; сохранять независимость проверяемого результата и проверок; не смешивать специальность агента, руководство комнатой и координацию всей фичи.

## Проверка по ролям

| Роль | Соответствие текущего описания | Рекомендуемое уточнение |
|---|---|---|
| Planner | Соответствует подготовке плана: результат, зависимости, вопросы, критерии приёмки и назначаемые шаги. | Явно учитывать риски и доступные ресурсы. Постоянная координация исполнения появляется при назначении лидом комнаты, а не из специальности Planner. Основа: [GOV.UK Delivery Manager](https://understand-digital-data-roles-skills.service.gov.uk/role/delivery-manager/). |
| Architect | Соответствует проектированию границ, интерфейсов, вариантов решения и миграции. | Явнее назвать значимые свойства качества: безопасность, надёжность, производительность и сопровождаемость — только когда они существенны для задачи. Продуктовые компромиссы согласуются с человеком. Основа: [GOV.UK Solution Architect](https://understand-digital-data-roles-skills.service.gov.uk/role/solution-architect/). |
| Critic | Соответствует критической оценке плана: предположения, порядок зависимостей, сценарии отказа, существенность замечаний. | Прямо разрешить вывод об отсутствии существенных возражений. Не требовать замечаний ради количества. Это перенос функции design review, а не самостоятельная общепринятая должность. Основа: [NASA Design Reviews](https://s3vi.ndc.nasa.gov/ssri-kb/topics/57/). |
| Executor | Соответствует разработчику, реализующему назначенный объём и проверяющему изменение. | Сохранить ответственность за нужные тесты и документацию в пределах задачи. Не передавать всю ответственность за качество Reviewer или Verifier. Основа: [GOV.UK Software Developer](https://understand-digital-data-roles-skills.service.gov.uk/role/software-developer/). |
| Reviewer | Соответствует проверке изменения: требования, контекст, дефекты, регрессии и достаточность проверок. | Расширить явную область внимания на дизайн, сложность, сопровождаемость и существенные риски безопасности. Сохранять проверяемость и приоритет замечаний; личные вкусы не делать блокерами. Основа: [Google Engineering Practices](https://google.github.io/eng-practices/review/reviewer/looking-for.html). |
| Verifier | Соответствует проверке результата по согласованным требованиям, но формулировки исходов и допустимых изменений требуют уточнения. | Отчёт: PASS, FAIL или NOT VERIFIED. Проверяемые код, тесты, эталоны и настройки не менять ради получения успешного результата. Это более узкая функция, чем полный Test Engineer. Основа: [NASA Verification and Validation](https://www.nasa.gov/reference/2-4-distinctions-between-product-verification-and-product-validation/), [GOV.UK Test Engineer](https://understand-digital-data-roles-skills.service.gov.uk/role/test-engineer/). |
| Debugger | Соответствует диагностике и исправлению: воспроизведение, проверка причинной гипотезы, локальный ремонт и проверка поведения. | Отличать доказанную причину от вероятной, особенно когда воспроизведение недоступно. Фиксировать полезные опровергнутые гипотезы и защиту от повторения дефекта. Основа: [Google SRE: Effective Troubleshooting](https://sre.google/sre-book/effective-troubleshooting/). |
| Researcher | Соответствует техническому исследованию: конкретный вопрос, проверяемые данные, разделение фактов и вывода, ограничения. | Выбирать источники под вопрос; правило «сначала код» подходит вопросам о репозитории, но не должно требовать ненужного чтения кода для внешнего исследования. Отмечать противоречия и актуальность данных. Основа: [GOV.UK GovS 010: Analysis](https://www.gov.uk/government/publications/government-analysis-functional-standard--2/government-functional-standard-govs-010-analysis). |
| Feature Lead — проект | Соответствует ответственности за общую поставку фичи: цель, зависимости, блокеры, согласование команд и готовность результата. | В Parley координирует лидов комнат, не пишет код и не заменяет полномочия человека. Владение комнатами пока является проектируемой возможностью. Основа: [Bolt](https://medium.com/bolt-labs/feature-leading-at-bolt-more-than-writing-code-99a1fa352e2b), [опыт Feature Lead в Nested](https://craigtaub.dev/how-the-feature-lead-role-helped-me-grow/). |

## Приоритетные поправки

### 1. У Verifier нужен явный исход «не проверено»

В `builtin.ts:102` описание обещает pass/fail, а `builtin.ts:110–111` одновременно требует отличать недоступную проверку от проваленной и давать pass/fail для каждого критерия. Недостаток доказательств не подтверждает ни успех, ни дефект продукта.

Предлагаемая формулировка отчёта:

> Report PASS, FAIL, or NOT VERIFIED for each acceptance criterion, with evidence and any missing prerequisites. Never report success for a check that could not be completed.

Это уточнение человеческого отчёта, а не предложение нового состояния плана. Отсутствующее доказательство должно сохранять пункт незавершённым или возвращать его с объяснением в рамках существующего процесса.

### 2. Verifier сохраняет проверяемые артефакты

`readOnly: false` у Verifier намеренно позволяет запускать проверки, создающие временные файлы и результаты сборки. Текущий запрет касается только implementation code; изменение тестов, ожидаемых результатов или настроек явно не оговорено.

Предлагаемое ограничение:

> Run relevant checks and inspect their outputs. Checks may create temporary files and generated artifacts. Do not modify the submitted implementation, tests, fixtures, expected results, or configuration. Preserve failures and return required fixes to the responsible owner.

Это граница специализации Parley. Полноценный Test Engineer может создавать и поддерживать тестовые наборы; Verifier здесь оценивает предъявленный результат. Новые постоянные тесты поручаются исполнителю отдельной задачей, временные проверочные материалы допустимы в рамках назначения и разрешений.

### 3. Независимая проверка не всегда означает повторный запуск тестов

Рецепт `Plan & build` включает Planner, Critic, Executor и Reviewer. Он уже задаёт отдельного участника для оценки результата, но сам по себе не гарантирует независимый запуск тестов. Проверка посредством анализа и инспекции тоже допустима; достаточность метода определяется критериями приёмки.

Если нужны исполняемые независимые проверки, их следует явно назначить участнику с необходимыми разрешениями. Постоянно добавлять Verifier во все комнаты не требуется. Это сохраняет достаточную проверку без обязательной дополнительной сессии для каждой задачи.

### 4. Специальность и полномочия разделены

- Специальность определяет работу: Planner готовит план, Reviewer оценивает изменение, Executor реализует.
- Лид комнаты координирует её участников и процесс решений. Уже сейчас им может быть Planner, Reviewer или Debugger.
- Проектируемый Feature Lead согласует общую цель нескольких комнат и оценивает совокупный результат. Само название роли не даёт права обходить лидов комнат или принимать решения за человека.

Verifier проверяет соответствие согласованным требованиям. Feature Lead оценивает совокупный результат относительно цели пользователя, опираясь на технические доказательства и необходимые пользовательские проверки. Успех технических проверок сам по себе не доказывает достижение продуктовой цели — это соответствует различию verification/validation у NASA.

## Короткие английские описания для будущего каталога

Это оригинальные предлагаемые формулировки, а не цитаты из источников. Полные prompts сохраняют существующие инструкции по отчётам, границам записи и эскалации.

| Role | Proposed description |
|---|---|
| Planner | Turn an agreed goal into an assignable plan with clear scope, dependencies, risks, and acceptance criteria. |
| Architect | Define a viable technical design with clear boundaries, interfaces, constraints, and quality tradeoffs. |
| Critic | Challenge plans and decisions with evidence, credible failure scenarios, and prioritized actionable findings. |
| Executor | Implement the assigned scope, maintain relevant tests and documentation, and verify the resulting behavior. |
| Reviewer | Review submitted changes for correctness, design quality, maintainability, and relevant risks without modifying them. |
| Verifier | Check the delivered result against acceptance criteria and report pass, fail, or not verified with evidence. |
| Debugger | Investigate a failure, establish its cause where evidence permits, and verify a focused repair. |
| Researcher | Answer a scoped question using traceable evidence, distinguishing findings, inference, and uncertainty. |
| Feature Lead | Coordinate room leads to deliver a feature's agreed outcome, resolve dependencies and blockers, and validate the combined result without writing code. |

## Проверка и ограничения аудита

Просмотрены встроенные prompts, метаданные ролей, рецепты, правила лидерства и применение разрешений при запуске. Сведения сопоставлены с первичными описаниями обязанностей и инженерных практик; соответствие — экспертная оценка, не сертификация по единому стандарту должностей.

Флаг `readOnly` имеет разные механизмы применения: Codex получает read-only sandbox; для Claude запрещаются инструменты Edit/Write/NotebookEdit, а запрет записи через shell задаётся инструкцией. Описание роли не следует представлять как одинаково жёсткую техническую гарантию для всех провайдеров.

Поведение агентов в живых сессиях не проверялось. Программный код, роли и рецепты не изменялись; тесты приложения не запускались, поскольку результат этого прохода — аудит и предлагаемые тексты.
