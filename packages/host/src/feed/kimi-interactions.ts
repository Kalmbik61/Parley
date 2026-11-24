import {
  FEED_INPUT_LIMIT,
  type FeedCard,
  type FeedDecision,
  type FeedQuestion,
  type FeedQuestionField,
  type FeedQuestionOption,
  type FeedQuestionValue,
} from '@parley/core';
import { FEED_DECISION_ANSWERS, FEED_DECISION_ANSWER_LIMIT, type KimiRequest, type KimiResponse } from '@parley/protocol';

type Elicitation = Extract<KimiRequest, { kind: 'elicitation' }>;
type StructuredQuestion = FeedQuestion & { field: FeedQuestionField };

export interface KimiInteraction {
  request: KimiRequest;
  card: FeedCard;
  answer(decision: FeedDecision): { response: KimiResponse; decision: FeedDecision } | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.slice(0, FEED_INPUT_LIMIT) : undefined;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function choices(schema: Record<string, unknown>): FeedQuestionOption[] | undefined {
  const titled = schema['oneOf'] ?? schema['anyOf'];
  const entries: Record<string, unknown>[] | undefined = Array.isArray(titled)
    ? titled.map(record)
    : Array.isArray(schema['enum'])
      ? schema['enum'].map((value: unknown) => ({ const: value }))
      : undefined;
  if (entries === undefined || entries.length === 0) return undefined;
  const result: FeedQuestionOption[] = [];
  for (const entry of entries) {
    const value = entry['const'];
    if (typeof value !== 'string' || value.length > FEED_INPUT_LIMIT || result.some((option) => option.value === value)) return undefined;
    result.push({ value, label: text(entry['title']) ?? value, description: text(entry['description']) ?? null });
  }
  return result;
}

function formQuestion(id: string, schema: Record<string, unknown>, required: boolean): StructuredQuestion | undefined {
  if (id.length === 0 || id.length > FEED_INPUT_LIMIT || id === '__proto__') return undefined;
  const type = schema['type'];
  const multiSelect = type === 'array';
  const options = choices(multiSelect ? record(schema['items']) : schema);
  const hasChoices = 'oneOf' in schema || 'anyOf' in schema || 'enum' in schema;
  const fieldType = !hasChoices && (type === 'boolean' || type === 'number' || type === 'integer') ? type
    : options !== undefined && (multiSelect || type === 'string') ? 'choice'
    : type === 'string' && !hasChoices ? 'text'
    : undefined;
  if (fieldType === undefined) return undefined;
  const min = number(schema[multiSelect ? 'minItems' : type === 'string' ? 'minLength' : 'minimum']);
  const max = number(schema[multiSelect ? 'maxItems' : type === 'string' ? 'maxLength' : 'maximum']);
  if (min !== undefined && max !== undefined && min > max) return undefined;
  if (multiSelect && min !== undefined && min > Math.min(options?.length ?? 0, FEED_DECISION_ANSWERS)) return undefined;
  if (fieldType === 'text' && min !== undefined && min > FEED_DECISION_ANSWER_LIMIT) return undefined;
  const description = text(schema['description']);
  const field: FeedQuestionField = {
    id, type: fieldType, required,
    ...(description === undefined ? {} : { description }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
  return {
    question: text(schema['title']) ?? id,
    header: null,
    options: fieldType === 'boolean' ? [
      { value: 'true', label: 'True', description: null },
      { value: 'false', label: 'False', description: null },
    ] : options ?? [],
    multiSelect,
    field,
  };
}

function validAnswer(question: StructuredQuestion, value: FeedQuestionValue): boolean {
  const field = question.field;
  const within = (size: number): boolean =>
    (field.min === undefined || size >= field.min) && (field.max === undefined || size <= field.max);
  switch (field.type) {
    case 'text': return typeof value === 'string' && within([...value].length);
    case 'number': return typeof value === 'number' && Number.isFinite(value) && within(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value) && within(value);
    case 'boolean': return typeof value === 'boolean';
    case 'choice': {
      const known = (id: string) => question.options.some((option) => option.value === id);
      return question.multiSelect
        ? Array.isArray(value) && within(value.length) && new Set(value).size === value.length && value.every(known)
        : typeof value === 'string' && known(value);
    }
  }
}

function displayAnswer(question: FeedQuestion, value: FeedQuestionValue): string {
  const label = (choice: string) => question.options.find((option) => option.value === choice)?.label ?? choice;
  return Array.isArray(value) ? value.map(label).join(', ') : label(String(value));
}

function formQuestions(request: Elicitation): StructuredQuestion[] | undefined {
  const fields = Object.entries(request.requestedSchema.properties);
  if (fields.length === 0 || fields.length > FEED_DECISION_ANSWERS) return undefined;
  const required = new Set(request.requestedSchema.required);
  const questions: StructuredQuestion[] = [];
  for (const [id, schema] of fields) {
    const question = formQuestion(id, schema, required.delete(id));
    if (question === undefined) return undefined;
    questions.push(question);
  }
  return required.size === 0 ? questions : undefined;
}

export const canShowKimiElicitation = (request: Elicitation): boolean => formQuestions(request) !== undefined;

export function kimiInteraction(request: KimiRequest, at: string): KimiInteraction | undefined {
  const id = `kimi:${request.id}`;
  const base = {
    id, cardId: id, at, state: 'pending' as const,
    toolUseId: request.toolCallId ?? null,
    toolInput: {},
  };
  if (request.kind === 'elicitation') {
    const questions = formQuestions(request);
    if (questions === undefined) return undefined;
    return {
      request,
      card: {
        ...base, kind: 'question', toolName: 'AskUserQuestion', questions,
        formPrompt: request.message.slice(0, FEED_INPUT_LIMIT),
      },
      answer(decision) {
        if (decision.kind !== 'question' || decision.values === undefined) return undefined;
        const values = decision.values;
        if (Object.keys(values).some((key) => !Object.hasOwn(request.requestedSchema.properties, key))) return undefined;
        const answers: Array<[string, string]> = [];
        for (const question of questions) {
          const { id, required } = question.field;
          if (!Object.hasOwn(values, id)) {
            if (required) return undefined;
            continue;
          }
          const value = values[id]!;
          if (!validAnswer(question, value)) return undefined;
          const repeatedTitle = questions.some((other) => other !== question && other.question === question.question);
          answers.push([repeatedTitle ? `${question.question} (${id})` : question.question, displayAnswer(question, value)]);
        }
        return {
          response: { kind: 'elicitation', action: 'accept', content: values },
          decision: { kind: 'question', answers: Object.fromEntries(answers) },
        };
      },
    };
  }

  // Kimi uses the permissions method for its own fallback, but the reply is an answer to a question.
  if (request.title === 'AskUserQuestion' || request.options.every(({ optionId }) => /^q\d+_(?:opt_\d+|skip)$/.test(optionId))) {
    const question = request.content.flatMap((part) => part.type === 'content' ? [part.content.text] : [])
      .join('\n').slice(0, FEED_INPUT_LIMIT) || request.title;
    return {
      request,
      card: {
        ...base, kind: 'question', toolName: request.title,
        questions: [{
          question, header: null, multiSelect: false,
          field: { id: 'answer', type: 'choice', required: true },
          options: request.options.map(({ name, optionId }) => ({ label: name, value: optionId, description: null })),
        }],
      },
      answer(decision) {
        if (decision.kind !== 'question' || Object.keys(decision.values ?? {}).length !== 1) return undefined;
        const option = request.options.find(({ optionId }) => optionId === decision.values?.['answer']);
        if (option === undefined) return undefined;
        return {
          response: { kind: 'permission', optionId: option.optionId },
          decision: { kind: 'question', answers: { [question]: option.name } },
        };
      },
    };
  }

  return {
    request,
    card: {
      ...base, kind: 'permission', toolName: request.title, suggestions: [], notified: false,
      permissionOptions: request.options,
      permissionPreview: request.content.map((part) => part.type === 'content'
        ? { type: 'text', text: part.content.text }
        : { type: 'diff', path: part.path, oldText: part.oldText ?? null, newText: part.newText }),
      ...(request.contentTruncated || request.content.some((part) => part.truncated) ? { truncated: true } : {}),
    },
    answer(decision) {
      if (decision.kind !== 'permission') return undefined;
      const option = request.options.find(({ optionId }) => optionId === decision.optionId);
      if (option === undefined || option.kind.startsWith('allow_') !== (decision.behavior === 'allow')) return undefined;
      return {
        response: { kind: 'permission', optionId: option.optionId },
        decision: { kind: 'permission', behavior: decision.behavior },
      };
    },
  };
}
