/**
 * Карточка разрешения (план 2026-10-01, решения 3 и 4, кусок 4a, решение Р): что именно агент хочет
 * сделать и кнопки «Allow», «Allow and don't ask again» (только если CLI предложил правило —
 * `suggestions` с `addRules`) и «Deny» с необязательным текстом для модели. Решение уходит
 * `feed.decide`; ответа хуку без клика человека здесь нет.
 *
 * Тело по `toolInput`: `Bash` — команда и описание; `Edit`/`MultiEdit` — путь и «до/после» (хунков на
 * этапе запроса нет); `Write` — путь и свёрнутое содержимое; прочее, в том числе MCP, — свёрнутые
 * аргументы JSON. Длинное переносится и прокручивается внутри карточки, кнопки переносятся рядом.
 */

import { useState } from 'react';
import type { FeedPermissionCard } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { toolHeadline } from '../feed-model.js';
import { useChatUiStore, EMPTY_CARD_DRAFT } from '../ui-store.js';
import { CardFrame } from './CardFrame.js';
import { CardNote } from './CardNote.js';
import { useCardDecision } from './use-card-decision.js';

const BLOCK = 'm-0 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/40 px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]';

function str(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' ? value : null;
}

/** Правила из подсказки `addRules`: `Bash(npm test)`; прочие подсказки кнопку не рождают. */
export function alwaysRules(suggestions: readonly unknown[]): string[] | null {
  const rules: string[] = [];
  let found = false;
  for (const suggestion of suggestions) {
    if (typeof suggestion !== 'object' || suggestion === null) continue;
    const entry = suggestion as { type?: unknown; rules?: unknown };
    if (entry.type !== 'addRules') continue;
    found = true;
    if (!Array.isArray(entry.rules)) continue;
    for (const rule of entry.rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { toolName, ruleContent } = rule as { toolName?: unknown; ruleContent?: unknown };
      if (typeof toolName !== 'string') continue;
      rules.push(typeof ruleContent === 'string' && ruleContent !== '' ? `${toolName}(${ruleContent})` : toolName);
    }
  }
  return found ? rules : null;
}

function Collapsible({ label, hideLabel, children }: { label: string; hideLabel: string; children: JSX.Element }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-testid="card-toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {open ? hideLabel : label}
      </button>
      {open ? children : null}
    </div>
  );
}

function PathLine({ path }: { path: string }): JSX.Element {
  return <span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{path}</span>;
}

function Change({ before, after }: { before: string; after: string }): JSX.Element {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{S.chat.card.before}</span>
        <pre data-testid="card-before" className={BLOCK}>{before}</pre>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{S.chat.card.after}</span>
        <pre data-testid="card-after" className={BLOCK}>{after}</pre>
      </div>
    </div>
  );
}

function Details({ item }: { item: FeedPermissionCard }): JSX.Element {
  const input = item.toolInput;
  const path = str(input, 'file_path');
  if (item.toolName === 'Bash') {
    const command = str(input, 'command');
    const description = str(input, 'description');
    return (
      <>
        {command === null ? null : <pre data-testid="card-command" className={BLOCK}>{command}</pre>}
        {description === null ? null : <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{description}</p>}
      </>
    );
  }
  if (item.toolName === 'Edit' && path !== null) {
    return (
      <>
        <PathLine path={path} />
        <Change before={str(input, 'old_string') ?? ''} after={str(input, 'new_string') ?? ''} />
      </>
    );
  }
  if (item.toolName === 'MultiEdit' && path !== null) {
    const edits = Array.isArray(input['edits']) ? (input['edits'] as unknown[]) : [];
    return (
      <>
        <PathLine path={path} />
        {edits.map((edit, at) => {
          const entry = (typeof edit === 'object' && edit !== null ? edit : {}) as Record<string, unknown>;
          return <Change key={at} before={str(entry, 'old_string') ?? ''} after={str(entry, 'new_string') ?? ''} />;
        })}
      </>
    );
  }
  if (item.toolName === 'Write' && path !== null) {
    return (
      <>
        <PathLine path={path} />
        <Collapsible label={S.chat.card.showContent} hideLabel={S.chat.card.hideContent}>
          <pre data-testid="card-content" className={BLOCK}>{str(input, 'content') ?? ''}</pre>
        </Collapsible>
      </>
    );
  }
  const { name } = toolHeadline(item.toolName, input);
  return (
    <>
      <span className="font-mono text-xs [overflow-wrap:anywhere]">{name}</span>
      <Collapsible label={S.chat.card.showArguments} hideLabel={S.chat.card.hideArguments}>
        <pre data-testid="card-arguments" className={BLOCK}>{JSON.stringify(input, null, 2)}</pre>
      </Collapsible>
    </>
  );
}

function settledStatus(item: FeedPermissionCard): string {
  if (item.state === 'allowed' && item.always === true) return S.chat.card.allowedAlways;
  if (item.state === 'denied' && item.message !== undefined && item.message !== '') return S.chat.card.deniedWith(item.message);
  return item.state === 'pending' ? S.chat.waiting : S.chat.cardState[item.state];
}

export function PermissionCard({ item }: { item: FeedPermissionCard }): JSX.Element {
  const { key, deciding, note, decide } = useCardDecision(item.cardId);
  const message = useChatUiStore((state) => (state.cardDrafts[key] ?? EMPTY_CARD_DRAFT).message);
  if (item.state !== 'pending') return <CardFrame item={item} status={settledStatus(item)} />;

  const rules = alwaysRules(item.suggestions);
  const deny = (): void => {
    const text = message.trim();
    decide({ kind: 'permission', behavior: 'deny', ...(text === '' ? {} : { message: text }) });
  };
  return (
    <CardFrame item={item} status={null}>
      <Details item={item} />
      {item.truncated === true ? <p className="m-0 text-xs text-[var(--status-warning-text)]">{S.chat.inputTruncated}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" data-testid="card-allow" disabled={deciding} onClick={() => decide({ kind: 'permission', behavior: 'allow' })}>
          {S.chat.card.allow}
        </Button>
        {rules === null ? null : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="card-allow-always"
            title={rules.length === 0 ? undefined : S.chat.card.allowAlwaysTitle(rules.join(', '))}
            disabled={deciding}
            onClick={() => decide({ kind: 'permission', behavior: 'allow', always: true })}
          >
            {S.chat.card.allowAlways}
          </Button>
        )}
        <Button type="button" size="xs" variant="outline" data-testid="card-deny" disabled={deciding} onClick={deny}>
          {S.chat.card.deny}
        </Button>
        <Input
          data-testid="card-deny-message"
          aria-label={S.chat.card.denyMessage}
          placeholder={S.chat.card.denyMessage}
          value={message}
          disabled={deciding}
          onChange={(event) => useChatUiStore.getState().setCardDraft(key, { message: event.target.value })}
          className="h-6 min-w-40 flex-1 px-2 text-xs"
        />
      </div>
      <CardNote note={note} />
    </CardFrame>
  );
}
