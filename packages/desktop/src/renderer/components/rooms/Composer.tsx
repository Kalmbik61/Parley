/**
 * Поле ввода ленты комнаты (кусок 3.6 плана окна, спека 6.3): адресат —
 * «всем» (`to: []`) или выбранные участники, вид письма и текст, ⌘Enter
 * отправляет. Закрытую сессию выбрать нельзя (спека 6.3, «закрытые
 * недоступны») — флажок `disabled`, а не просто скрыт: пользователь должен
 * видеть, что участник есть, но недоступен, а не что он пропал из комнаты.
 *
 * Письма человека лимитом `messageRate` не ограничены (спека 6.3) — здесь
 * этого и не видно: лимит проверяет хост при `rooms.send`, а не поле ввода.
 *
 * Кусок 1.4 плана «облик Orca»: `ui/checkbox` для «всем»/участников (список
 * многовыборный, не одиночная настройка — `ui/switch` тут не подходит),
 * `ui/select` для вида письма, `ui/textarea` и `ui/button` для текста и
 * отправки.
 */

import { useState } from 'react';
import type { MessageKind } from '@harnas/core';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Textarea } from '../../ui/textarea.js';

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
  note: S.rooms.kindLabels.note,
  question: S.rooms.kindLabels.question,
  decision: S.rooms.kindLabels.decision,
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
    <div className="flex flex-col gap-2 border-t border-border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={selected.size === 0} onCheckedChange={() => setSelected(new Set())} />
          {S.rooms.everyone}
        </label>
        {members.map((member) => (
          <label key={member.id} className={`flex items-center gap-1.5 ${member.closed ? 'opacity-50' : ''}`}>
            <Checkbox
              checked={selected.has(member.id)}
              disabled={member.closed}
              onCheckedChange={() => toggleMember(member)}
            />
            {member.label}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Select value={kind} onValueChange={(value) => setKind(value as MessageKind)}>
          <SelectTrigger className="h-7 w-auto gap-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(KIND_LABELS) as MessageKind[]).map((value) => (
              <SelectItem key={value} value={value}>
                {KIND_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.metaKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={S.rooms.composerPlaceholder}
        className="min-h-16 resize-none"
      />
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={submit}>
          {S.rooms.send}
        </Button>
      </div>
    </div>
  );
}
