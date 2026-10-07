/**
 * Письма плана от `parley` в ленте (`plan-letter.ts`): разбор по разделам, сверка фраз с исходником core, правило путей
 * (`isPathToken`, `remarkCodePaths`) и отрисовка в `RoomMessage`. Образцы — письма из живой ленты комнаты.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageModel } from './feed-model.js';
import { PLAN_LETTER_TAILS, planLetterMarkdown } from './plan-letter.js';
import { RoomMarkdown } from './RoomMarkdown.js';
import { RoomMessage } from './RoomMessage.js';
import { isPathToken } from './room-remark.js';

afterEach(cleanup);

const READY = [
  'Accepted plan pl-01, revision 0, item 2: Бэкенд: стор документов и приём файла',
  'Scope:',
  'scanumbackend: src/services/patient_document_store.py — вся работа с GridFS (motor) только здесь. Тип по magic bytes (PDF/JPEG/PNG).',
  'Criteria:',
  'pytest: файл 21 МБ → 413, в GridFS ничего не осталось.',
  'Новые тесты зелёные; ruff без новых ошибок.',
  PLAN_LETTER_TAILS.ready,
].join('\n');

const VERIFY = [
  'Accepted plan pl-01, revision 0, item 1: Контракт API и схема хранения',
  'Scope:',
  'Файл .omc/docs/contracts/patient-documents-contract.md по эскизу §6 плана.',
  'Criteria:',
  'Описаны все 8 ручек с кодами 200/201/204/401/403/404.',
  'Evidence:',
  'Контракт написан.',
  '.omc/docs/contracts/patient-documents-contract.md',
  PLAN_LETTER_TAILS.verify,
].join('\n');

const RETURNED = [
  'Accepted plan pl-01, revision 0, item 1: Контракт API',
  'Scope:',
  'Файл контракта.',
  'Returned for rework: Поправить шесть мест.',
  '',
  '1. Rate-limit (§3). `utils/rate_limit.py:40-72` умеет только минутное окно.',
  PLAN_LETTER_TAILS.returned,
].join('\n');

describe('planLetterMarkdown', () => {
  it('фразы, по которым окно узнаёт письмо, — дословно из core/plan-effects.ts', () => {
    const source = readFileSync(path.resolve(process.cwd(), '../core/src/work/plan-effects.ts'), 'utf8');
    for (const tail of Object.values(PLAN_LETTER_TAILS)) expect(source).toContain(tail);
    for (const fragment of ['Accepted plan ${plan.id}, revision ${plan.rev}, item ${item.id}: ${item.title}', '\\nScope:\\n', '\\nCriteria:\\n', '\\nEvidence:\\n', '\\nReturned for rework: ', '\\nBlocked: ', 'is ready for human completion. Collect remaining work through backlog_list/backlog_suggest, then call propose_completion with this exact planId/rev and a summary.', 'Room mode changed. ']) {
      expect(source).toContain(fragment);
    }
  });

  it('назначение: название жирным, строка плана, Scope, Criteria списком, Next с инструментами кодом', () => {
    expect(planLetterMarkdown(READY)).toBe([
      '**Бэкенд: стор документов и приём файла**\nAccepted plan pl-01, revision 0, item 2',
      '**Scope**\nscanumbackend: src/services/patient_document_store.py — вся работа с GridFS (motor) только здесь. Тип по magic bytes (PDF/JPEG/PNG).',
      '**Criteria**\n- pytest: файл 21 МБ → 413, в GridFS ничего не осталось.\n- Новые тесты зелёные; ruff без новых ошибок.',
      '**Next:** Perform this accepted assignment; use `plan_update` and `plan_submit` with this exact planId/rev/item. A skill named in scope is guidance, not automatic loading.',
    ].join('\n\n'));
  });

  it('проверка: Evidence отдельным разделом; возврат: заметка целиком, со списком и кодом', () => {
    const verify = planLetterMarkdown(VERIFY) ?? '';
    expect(verify).toContain('**Evidence**\nКонтракт написан.\n.omc/docs/contracts/patient-documents-contract.md');
    expect(verify).toContain('**Next:** Independently inspect the result and call `plan_verify`');
    const returned = planLetterMarkdown(RETURNED) ?? '';
    expect(returned).toContain('**Returned for rework**\nПоправить шесть мест.\n\n1. Rate-limit (§3). `utils/rate_limit.py:40-72` умеет только минутное окно.');
    expect(returned).not.toContain('**Criteria**');
  });

  it('блокировка, готовность к завершению, смена режима и возврат завершения', () => {
    expect(planLetterMarkdown(`Accepted plan pl-02, revision 1, item 3: API\nBlocked: Owner is unavailable.\n${PLAN_LETTER_TAILS.blocked}`))
      .toBe(`**API**\nAccepted plan pl-02, revision 1, item 3\n\n**Blocked**\nOwner is unavailable.\n\n**Next:** ${PLAN_LETTER_TAILS.blocked}`);
    expect(planLetterMarkdown('Plan pl-02, revision 1 is ready for human completion. Collect remaining work through backlog_list/backlog_suggest, then call propose_completion with this exact planId/rev and a summary.'))
      .toBe('**Plan pl-02, revision 1 is ready for human completion.**\n\n**Next:** Collect remaining work through `backlog_list`/`backlog_suggest`, then call `propose_completion` with this exact planId/rev and a summary.');
    expect(planLetterMarkdown(`Room mode changed. You switched the room to verified: смена\n${PLAN_LETTER_TAILS.mode}`))
      .toBe(`**Room mode changed.** You switched the room to verified: смена\n\n**Next:** ${PLAN_LETTER_TAILS.mode}`);
    expect(planLetterMarkdown(`Plan pl-02, revision 1: Добавь итог по тестам.\n${PLAN_LETTER_TAILS.completionReturned}`))
      .toBe(`**Plan pl-02, revision 1:** Добавь итог по тестам.\n\n**Next:** ${PLAN_LETTER_TAILS.completionReturned}`);
  });

  it('слова письма не пропадают: человек видит то, что прочтёт агент', () => {
    for (const text of [READY, VERIFY, RETURNED]) {
      const markdown = planLetterMarkdown(text) ?? '';
      for (const word of text.split(/\s+/).filter((w) => w !== '' && !/^(Scope|Criteria|Evidence):$/.test(w))) {
        expect(markdown.replace(/[*`]/g, '')).toContain(word.replace(/[*`]/g, '').replace(/:$/, ''));
      }
    }
  });

  it('не письмо плана — null: текст агента, неизвестная последняя фраза, заголовок без тела', () => {
    expect(planLetterMarkdown('Готово, смотри src/app.ts')).toBeNull();
    expect(planLetterMarkdown(READY.replace(PLAN_LETTER_TAILS.ready, 'Something else.'))).toBeNull();
    expect(planLetterMarkdown('Accepted plan pl-01, revision 0, item 2: title')).toBeNull();
    expect(planLetterMarkdown('Room mode changed. Без хвоста')).toBeNull();
  });

  it('звёздочка в названии не ломает жирное', () => {
    expect(planLetterMarkdown(`Accepted plan pl-01, revision 0, item 1: a*b\nBlocked: x\n${PLAN_LETTER_TAILS.blocked}`)).toContain('**a\\*b**');
  });
});

describe('isPathToken', () => {
  it.each([
    'src/services/patient_document_store.py',
    '.omc/docs/contracts/patient-documents-contract.md',
    'utils/rate_limit.py:40-72',
    '.omc/worktrees/frontend-documents',
    'src/features/patient-documents',
    '~/Desktop/scanum',
    './scripts/run.sh',
    '/Users/me/project/README.md',
    'packages/desktop/src',
  ])('путь: %s', (token) => expect(isPathToken(token)).toBe(true));

  it.each([
    '200/201/204/401/403/404',
    'guest/patient/administrator/administrator_medical',
    'PDF/JPEG/PNG',
    'and/or',
    'uploaded/viewed/deleted',
    'planId/rev/item',
    'origin/develop',
    'features/patient-documents/api',
    '/',
    'https://example.com/a.md',
    'patient_documents',
  ])('не путь: %s', (token) => expect(isPathToken(token)).toBe(false));
});

describe('пути кодом в ленте', () => {
  const codes = (container: HTMLElement): string[] => [...container.querySelectorAll('code')].map((node) => node.textContent ?? '');

  it('codePaths: путь — code, точка в конце фразы остаётся текстом; код и ссылка не трогаются', () => {
    const { container } = render(
      <RoomMarkdown
        text={'Файл .omc/docs/contract.md. Уже код: `src/a.ts`, ссылка [docs](https://example.com/src/b.ts), числа 200/201.'}
        labelOf={() => null}
        onOpenExternal={() => {}}
        codePaths
      />,
    );
    expect(codes(container)).toEqual(['.omc/docs/contract.md', 'src/a.ts']);
    expect(container.textContent).toContain('.omc/docs/contract.md. Уже код');
    expect(container.querySelector('a')?.textContent).toBe('docs');
  });

  it('без codePaths (сообщения агентов и человека) пути остаются текстом', () => {
    const { container } = render(<RoomMarkdown text="Файл src/app.ts" labelOf={() => null} onOpenExternal={() => {}} />);
    expect(codes(container)).toEqual([]);
  });

  const message = (patch: Partial<MessageModel>): MessageModel => ({
    id: 'm-01', sender: { kind: 'system', provider: null }, from: 'System', lead: false, to: 'S02', kind: 'note',
    at: '2026-10-07T10:00:00.000Z', text: READY, unread: false, needsRead: false, mentionsYou: false,
    delivery: { picked: [], waiting: [] }, reply: null, ...patch,
  });
  const renderMessage = (model: MessageModel) =>
    render(<RoomMessage message={model} now={new Date('2026-10-07T10:05:00.000Z')} labelOf={() => null} onOpenExternal={() => {}} onJumpTo={() => {}} />);

  it('письмо Parley в ленте: разделы жирным, критерии списком, путь и инструменты — code', () => {
    const { container } = renderMessage(message({}));
    const strong = [...container.querySelectorAll('strong')].map((node) => node.textContent);
    expect(strong).toEqual(['Бэкенд: стор документов и приём файла', 'Scope', 'Criteria', 'Next:']);
    expect(within(container).getAllByRole('listitem')).toHaveLength(2);
    expect(codes(container)).toEqual(['src/services/patient_document_store.py', 'plan_update', 'plan_submit']);
  });

  it('сообщение агента с тем же текстом остаётся как есть', () => {
    const { container } = renderMessage(message({ sender: { kind: 'agent', provider: 'claude' }, from: 'S01' }));
    expect(container.querySelector('strong')).toBeNull();
    expect(codes(container)).toEqual([]);
  });
});
