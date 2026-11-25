import { createTranslator, defineCatalog, type AppLocale } from './index.js';

const labels = defineCatalog(
  {
    'builtin:feature-lead.name': 'Feature Lead',
    'builtin:feature-lead.description':
      "Coordinate room leads to deliver a feature's agreed outcome, resolve dependencies and blockers, and validate the combined result without writing code.",
    'builtin:planner.name': 'Planner',
    'builtin:planner.description':
      'Turn an agreed goal into an assignable plan with clear scope, dependencies, risks, and acceptance criteria.',
    'builtin:architect.name': 'Architect',
    'builtin:architect.description':
      'Define a viable technical design with clear boundaries, interfaces, constraints, and quality tradeoffs.',
    'builtin:critic.name': 'Critic',
    'builtin:critic.description':
      'Challenge plans and decisions with evidence, credible failure scenarios, and prioritized actionable findings.',
    'builtin:executor.name': 'Executor',
    'builtin:executor.description':
      'Implement the assigned scope, maintain relevant tests and documentation, and verify the resulting behavior.',
    'builtin:reviewer.name': 'Reviewer',
    'builtin:reviewer.description':
      'Review submitted changes for correctness, design quality, maintainability, and relevant risks without modifying them.',
    'builtin:verifier.name': 'Verifier',
    'builtin:verifier.description':
      'Check the delivered result against acceptance criteria and report pass, fail, or not verified with evidence.',
    'builtin:debugger.name': 'Debugger',
    'builtin:debugger.description':
      'Investigate a failure, establish its cause where evidence permits, and verify a focused repair.',
    'builtin:researcher.name': 'Researcher',
    'builtin:researcher.description':
      'Answer a scoped question using traceable evidence, distinguishing findings, inference, and uncertainty.',
    'builtin:plan-build.name': 'Plan & build',
    'builtin:plan-build.description':
      'Clarify, challenge, implement and independently assess a bounded change.',
    'builtin:review.name': 'Review',
    'builtin:review.description':
      'Review correctness and design without changing the submitted code.',
    'builtin:debug.name': 'Debug',
    'builtin:debug.description':
      'Reproduce a failure, isolate its cause and prove a minimal repair.',
  },
  {
    'builtin:feature-lead.name': 'Руководитель разработки',
    'builtin:feature-lead.description':
      'Координирует ведущих комнат, устраняет зависимости и препятствия, проверяет общий результат и доводит разработку до согласованной цели.',
    'builtin:planner.name': 'Планировщик',
    'builtin:planner.description':
      'Разбивает согласованную цель на задачи с чётким объёмом работ, зависимостями, рисками и критериями приёмки.',
    'builtin:architect.name': 'Архитектор',
    'builtin:architect.description':
      'Проектирует техническое решение и описывает его границы, интерфейсы, ограничения и компромиссы.',
    'builtin:critic.name': 'Критик',
    'builtin:critic.description':
      'Проверяет планы и решения по имеющимся данным, рассматривает возможные сбои и расставляет приоритеты замечаний.',
    'builtin:executor.name': 'Исполнитель',
    'builtin:executor.description':
      'Реализует назначенную задачу, поддерживает связанные тесты и документацию и проверяет получившееся поведение.',
    'builtin:reviewer.name': 'Рецензент',
    'builtin:reviewer.description':
      'Проверяет переданные изменения на корректность, качество проектирования, удобство сопровождения и риски.',
    'builtin:verifier.name': 'Проверяющий',
    'builtin:verifier.description':
      'Сверяет результат с критериями приёмки и подкрепляет каждый вывод результатами проверки.',
    'builtin:debugger.name': 'Специалист по отладке',
    'builtin:debugger.description':
      'Исследует сбой, устанавливает причину по имеющимся данным и проверяет точечное исправление.',
    'builtin:researcher.name': 'Исследователь',
    'builtin:researcher.description':
      'Отвечает на конкретный вопрос и указывает источники, выводы и оставшуюся неопределённость.',
    'builtin:plan-build.name': 'Планирование и реализация',
    'builtin:plan-build.description':
      'Уточните задачу, проверьте план, реализуйте изменение и проведите независимую приёмку.',
    'builtin:review.name': 'Рецензирование',
    'builtin:review.description':
      'Проверьте корректность и устройство переданного кода, сохраняя его исходное состояние.',
    'builtin:debug.name': 'Отладка',
    'builtin:debug.description':
      'Воспроизведите сбой, изолируйте его причину и проверьте минимальное исправление.',
  },
);

type NameKey = Extract<keyof typeof labels.en, `${string}.name`>;
type BuiltinDisplayId = NameKey extends `${infer Id}.name` ? Id : never;

interface DisplayText {
  name: string;
  description: string;
}

interface DisplayEntry {
  id: string;
  source?: string;
  name: string;
  description?: string;
}

/** The original English labels remain the source for persisted definitions and agent context. */
export function builtinText(id: BuiltinDisplayId, locale: AppLocale): DisplayText {
  const t = createTranslator(locale, labels);
  return { name: t(`${id}.name`), description: t(`${id}.description`) };
}

/** Translate labels only on display, after catalog lookup and before rendering. */
function builtinDisplay(entry: DisplayEntry, locale: AppLocale): DisplayText {
  const { id, source, name, description = '' } = entry;
  if (
    locale === 'ru' &&
    (source === 'builtin' || source === undefined) &&
    Object.hasOwn(labels.ru, `${id}.name`)
  ) {
    const builtinId = id as BuiltinDisplayId;
    if (source === 'builtin' || name === builtinText(builtinId, 'en').name) {
      return builtinText(builtinId, locale);
    }
  }
  return { name, description };
}

export { builtinDisplay as recipeDisplay, builtinDisplay as roleDisplay };
