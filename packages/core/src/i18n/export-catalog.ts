import { defineCatalog } from './index.js';

export const planExportCatalog = defineCatalog(
  {
    title: 'Plan {id} — revision {rev} ({event})',
    workspace: 'Work: {workId}; room: {roomId}',
    status: 'Mode: {mode}; status: {status}',
    dates: 'Accepted: {accepted}; completed: {completed}; cancelled: {cancelled}',
    goal: 'Goal',
    items: 'Items',
    removed: 'Removed items at this amendment',
    owner: 'Owner: {owner}; label: {label}; role: {role}',
    itemStatus: 'Status: {status}; after: {after}; verifier: {verifier}',
    scope: 'Scope:',
    acceptedChecklist:
      'Completion basis: accepted Checklist revision {rev}; no verification claimed.',
    criteria: 'Criteria:',
    evidence: 'Evidence:',
    note: 'Note:',
    backlog: 'Backlog: {ids}',
    completion: 'Completion',
    deleted: '[deleted]',
    metadataTruncated: '{prefix}… [metadata truncated]',
  },
  {
    title: 'План {id} — редакция {rev} ({event})',
    workspace: 'Работа: {workId} · Комната: {roomId}',
    status: 'Режим: {mode} · Статус: {status}',
    dates: 'Принят: {accepted} · Завершён: {completed} · Отменён: {cancelled}',
    goal: 'Цель',
    items: 'Задачи',
    removed: 'Задачи, снятые в этой редакции',
    owner: 'Ответственный: {owner} · Имя: {label} · Роль: {role}',
    itemStatus: 'Статус: {status} · После: {after} · Проверяющий: {verifier}',
    scope: 'Объём работ:',
    acceptedChecklist:
      'Основание завершения — принятие чек-листа в редакции {rev}. Результат проверки не заявлен.',
    criteria: 'Критерии приёмки:',
    evidence: 'Подтверждение выполнения:',
    note: 'Заметка:',
    backlog: 'Бэклог: {ids}',
    completion: 'Завершение',
    deleted: '[удалено]',
    metadataTruncated: '{prefix}… [метаданные сокращены]',
  },
);

export const decisionExportCatalog = defineCatalog(
  {
    title: 'Decision {id} in {room}',
    lead: 'Lead: {member}',
    participants: 'Participants',
    decision: 'Decision',
    humanRemark: 'Human remark',
    planMode: 'Mode: {mode}',
    plan: 'Plan: {id}; revision: {rev}',
    planItems: 'Plan items',
    snapshot: 'Immutable {event} plan snapshot',
    backlog: 'Backlog: {ids}',
    deleted: '{id} (deleted)',
    legacyEscapes:
      '> Legacy unpaired UTF-16/control units are shown as literal \\uXXXX escapes. This is a generated representation.',
  },
  {
    title: 'Решение {id} · {room}',
    lead: 'Ведущий: {member}',
    participants: 'Участники',
    decision: 'Решение',
    humanRemark: 'Заметка пользователя',
    planMode: 'Режим: {mode}',
    plan: 'План: {id} · Редакция: {rev}',
    planItems: 'Задачи плана',
    snapshot: 'Неизменяемый снимок плана ({event})',
    backlog: 'Бэклог: {ids}',
    deleted: '{id} (удалена)',
    legacyEscapes:
      '> Одиночные единицы UTF-16 и управляющие символы из старых данных записаны в виде \\uXXXX. Этот текст сформирован автоматически.',
  },
);
