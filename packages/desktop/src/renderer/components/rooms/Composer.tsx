/**
 * Поле ввода ленты комнаты (кусок 3.6 плана окна, спека 6.3): адресат —
 * «всем» (`to: []`) или выбранные участники, вид письма и текст, ⌘Enter
 * отправляет. Закрытую сессию выбрать нельзя (спека 6.3, «закрытые
 * недоступны») — чекбокс `disabled`, а не просто скрыт: пользователь должен
 * видеть, что участник есть, но недоступен, а не что он пропал из комнаты.
 *
 * Письма человека лимитом `messageRate` не ограничены (спека 6.3) — здесь
 * этого и не видно: лимит проверяет хост при `rooms.send`, а не поле ввода.
 */

import { useState } from 'react';
import type { MessageKind } from '@harnas/core';

export interface ComposerMember {
  id: string;
  label: string;
  closed: boolean;
}

export interface ComposerSubmission {
  /** Пусто — «всем участникам» (спека 6.1). */
  to: string[];
  text: string;
  kind: MessageKind;
}

export interface ComposerProps {
  members: ComposerMember[];
  onSend: (submission: ComposerSubmission) => void;
}

const KIND_LABELS: Record<MessageKind, string> = {
  note: 'заметка',
  question: 'вопрос',
  decision: 'решение',
};

export function Composer({ members, onSend }: ComposerProps): JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [kind, setKind] = useState<MessageKind>('note');
  const [text, setText] = useState('');

  const toggleMember = (member: ComposerMember): void => {
    if (member.closed) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(member.id)) next.delete(member.id);
      else next.add(member.id);
      return next;
    });
  };

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    onSend({ to: [...selected], text: trimmed, kind });
    setText('');
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--h-overlay)] p-2 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--h-subtext)]">
        <label className="flex items-center gap-1">
          <input type="radio" checked={selected.size === 0} onChange={() => setSelected(new Set())} />
          всем
        </label>
        {members.map((member) => (
          <label key={member.id} className={`flex items-center gap-1 ${member.closed ? 'opacity-50' : ''}`}>
            <input
              type="checkbox"
              checked={selected.has(member.id)}
              disabled={member.closed}
              onChange={() => toggleMember(member)}
            />
            {member.label}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as MessageKind)}
          className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-xs"
        >
          {(Object.keys(KIND_LABELS) as MessageKind[]).map((value) => (
            <option key={value} value={value}>
              {KIND_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.metaKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="⌘Enter — отправить"
        className="min-h-16 resize-none rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1"
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          className="rounded bg-[var(--h-blue)] px-3 py-1 text-xs text-[var(--h-base)]"
        >
          Отправить
        </button>
      </div>
    </div>
  );
}
