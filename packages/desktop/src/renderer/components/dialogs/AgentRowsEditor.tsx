/**
 * Блок «Agents» диалогов «New session or room» и «New workspace»: подпись с «?», строки агентов (роль, звезда ведущего,
 * пилюли провайдера, модель, effort, worktree строки, «×»), итог запуска под строкой и «Add agent». Состояние живёт в
 * диалоге (`useAgentRows`, `agent-rows.ts`): блок только рисует его и сообщает об изменениях, чтобы оба диалога
 * показывали одни и те же строки.
 *
 * Звезда ведущего видна, когда задан `lead` (режим комнаты); значок worktree строки — когда агентов два и больше.
 */

import { useCallback, useRef, type ComponentPropsWithoutRef } from 'react';
import { roleModel as roleModelOf } from '@parley/core/role-choice';
import { GitBranch, Plus, X } from 'lucide-react';
import { providerName, S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { effortChoices } from '../../lib/effort-choices.js';
import { sessionTag } from '../../lib/participant.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { AgentIcon } from '../AgentIcon.js';
import { PILL } from '../providers/pill.js';
import { ProviderCard } from '../providers/ProviderCard.js';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  chosenEffort,
  chosenModel,
  infoOf,
  providerIdOf,
  roleOf,
  wantsWorktree,
  type AgentEnv,
  type AgentResult,
  type AgentRow,
} from './agent-rows.js';
import { FieldCaption } from './FieldHint.js';
import { radioGroupKeyDown } from './radio-keys.js';

/**
 * Список выбора не выше места, что осталось в окне: у примитива потолок `max-h-96`, и десять моделей Claude в окне 800×500
 * уходили за нижний край — пункты внизу было не достать.
 */
export const LIST_HEIGHT = 'max-h-[min(24rem,var(--radix-select-content-available-height))]';

/**
 * Длинный пункт списка обрезается многоточием, а не переносится и не уезжает за край: Radix Select не передаёт `className`
 * на `ItemText` (он сам отбрасывает его — текст копируется в триггер), поэтому `truncate` примитива на пункте не
 * действует. Правило — на самом пункте, для его последнего потомка, как у триггера.
 */
export const ITEM_CLIP = '[&>span:last-child]:min-w-0 [&>span:last-child]:truncate';

/** Свой наблюдатель для каждого поповера: анимация закрытия старого не отключает новый. */
function ProviderPopoverContent(props: ComponentPropsWithoutRef<typeof PopoverContent>): JSX.Element {
  const providerResize = useRef<ResizeObserver | null>(null);
  const observeProviderContent = useCallback((content: HTMLDivElement | null): void => {
    providerResize.current?.disconnect();
    providerResize.current = null;
    if (content === null || typeof ResizeObserver === 'undefined') return;
    // Radix ограничивает высоту после автофокуса: раскрываем только скрытый фокус этой карточки.
    const observer = new ResizeObserver((entries) => {
      const focused = content.ownerDocument.activeElement;
      if (!content.isConnected || !(focused instanceof HTMLElement) || !content.contains(focused) || content.clientHeight === 0) return;
      const bounds = content.getBoundingClientRect();
      const height = entries.find((entry) => entry.target === content)?.borderBoxSize[0]?.blockSize ?? content.offsetHeight;
      // Прямоугольники учитывают zoom-анимацию, scrollTop и размеры ResizeObserver — нет.
      const scale = bounds.height / height;
      if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) return;
      const top = bounds.top + content.clientTop * scale;
      const bottom = Math.min(bounds.bottom - content.clientTop * scale, top + content.clientHeight * scale);
      const rect = focused.getBoundingClientRect();
      if (rect.height <= 0 || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return;
      // Chromium кладёт scrollTop на сетку пикселей устройства, округляя к ближнему: при DPR 1 из 78.4 выходило 78, и низ
      // поля оставался на 0.4 px под краем карточки. Цель — сразу на сетке, с запасом в сторону раскрытия.
      const grid = window.devicePixelRatio || 1;
      if (rect.bottom > bottom) content.scrollTop = Math.ceil((content.scrollTop + (rect.bottom - bottom) / scale) * grid) / grid;
      else if (rect.top < top) content.scrollTop = Math.floor((content.scrollTop + (rect.top - top) / scale) * grid) / grid;
    });
    providerResize.current = observer;
    observer.observe(content);
  }, []);
  return <PopoverContent {...props} ref={observeProviderContent} />;
}

export interface AgentRowsEditorProps {
  agents: readonly AgentRow[];
  env: AgentEnv;
  results: Record<number, AgentResult>;
  /** Ключ ведущего — звезда видна (режим комнаты); `null` — звезды нет. */
  lead: number | null;
  /** Значок worktree строки: у двух и больше агентов. */
  showRowWorktree: boolean;
  worktreeAvailable: boolean;
  /** Общий флажок worktree диалога: строка без своего выбора берёт его. */
  worktree: boolean;
  /** Идёт запуск: всё заперто. */
  busy: boolean;
  /** Состав заперт: запущена хоть одна сессия или создана работа. */
  groupLocked: boolean;
  /** Ниже скольки строк удалять нельзя. */
  minRows: number;
  /** Открытая карточка провайдера (в диалоге: Escape закрывает сначала её). */
  providerCard: { row: number; provider: string } | null;
  onProviderCard(card: { row: number; provider: string } | null): void;
  reloadProviders(): Promise<void>;
  onLead(key: number): void;
  onUpdate(key: number, patch: Partial<Omit<AgentRow, 'key'>>): void;
  onRemove(key: number): void;
  onAdd(): void;
  /** Выбор другого провайдера гасит прежнюю ошибку диалога. */
  onClearError(): void;
}

export function AgentRowsEditor({
  agents, env, results, lead, showRowWorktree, worktreeAvailable, worktree, busy, groupLocked, minRows, providerCard,
  onProviderCard, reloadProviders, onLead, onUpdate, onRemove, onAdd, onClearError,
}: AgentRowsEditorProps): JSX.Element {
  const text = S.dialogs.newSession;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldCaption text={text.agentsField} hint={text.hints.agents} />
      <div className="flex min-w-0 flex-col gap-2">
        {agents.map((row, index) => {
          const role = roleOf(env, row);
          const info = infoOf(env, row);
          const roleModel = roleModelOf(role, providerIdOf(env, row));
          const displayedModel = row.modelTouched ? chosenModel(row, info) : roleModel;
          const models = info?.models ?? null;
          const efforts = effortChoices(info, chosenModel(row, info));
          // Без касания показывается умолчание роли, если оно есть среди уровней модели, иначе `Default`.
          const roleEffort = role?.effort ?? null;
          const roleEffortListed = roleEffort !== null && efforts?.some((level) => level.id === roleEffort) === true;
          const displayedEffort = row.effortTouched ? chosenEffort(row, info) : roleEffortListed ? roleEffort : null;
          const chosenId = providerIdOf(env, row);
          const result = results[row.key];
          const rowLocked = busy || result?.status === 'started';
          const isLead = row.key === lead;
          return (
            <div key={row.key} data-agent-row className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Select value={row.role ?? 'none'} disabled={rowLocked || env.roles.length === 0} onValueChange={value => {
                  const selectedRole = env.roles.find(item => item.id === value);
                  onUpdate(row.key, { role: value === 'none' ? null : value, roleMissing: null,
                    ...(selectedRole && (selectedRole.source !== 'builtin' || !row.providerTouched) ? { provider: selectedRole.provider } : {}) });
                }}>
                  <SelectTrigger aria-label={text.roleField} className="min-w-[132px] max-w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent className={LIST_HEIGHT}>
                    <SelectItem value="none">{text.noRole}</SelectItem>
                    {env.roles.map(item => <SelectItem key={item.id} value={item.id}>{item.readOnly ? '🔒 ' : ''}{S.roles.option(item.name, item.source)}</SelectItem>)}
                  </SelectContent>
                </Select>
                {lead !== null ? (
                  <button
                    type="button"
                    title={isLead ? text.lead : text.makeLead}
                    aria-label={isLead ? text.lead : text.makeLead}
                    aria-pressed={isLead}
                    disabled={busy}
                    onClick={() => onLead(row.key)}
                    className={cn(
                      'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-base leading-none hover:bg-foreground/10 disabled:pointer-events-none',
                      isLead ? 'text-ring' : 'text-neutral-600',
                    )}
                  >
                    {isLead ? '★' : '☆'}
                  </button>
                ) : null}
                <div role="radiogroup" aria-label={text.agentGroup(index + 1)} onKeyDown={radioGroupKeyDown} className="flex shrink-0 gap-1">
                  {(env.providers ?? []).map((provider) => {
                    const on = provider.id === chosenId;
                    return (
                      <Popover
                        key={provider.id}
                        open={providerCard?.row === row.key && providerCard.provider === provider.id}
                        onOpenChange={(cardOpen) => {
                          if (!cardOpen) onProviderCard(null);
                          else if (!rowLocked && (!provider.available || on)) onProviderCard({ row: row.key, provider: provider.id });
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={on}
                            tabIndex={on ? 0 : -1}
                            title={role !== undefined && role.source !== 'builtin' ? S.roles.providerLocked : providerName(provider.id, provider.label)}
                            disabled={rowLocked || (role !== undefined && role.source !== 'builtin')}
                            onClick={() => {
                              if (provider.available && !on) {
                                onUpdate(row.key, { provider: provider.id, providerTouched: true, model: null, modelTouched: false, effort: null, effortTouched: false });
                                onClearError();
                              }
                            }}
                            className={cn(
                              PILL,
                              on ? 'border-ring bg-neutral-100 font-semibold' : 'border-border hover:bg-foreground/7',
                              !provider.available && 'opacity-45',
                            )}
                          >
                            {/* Буква значка провайдера без бренда (`GLM` → «G») не должна попадать в имя кнопки. */}
                            <span aria-hidden="true" className="inline-flex">
                              <AgentIcon provider={provider.id} size={14} />
                            </span>
                            {provider.label}
                          </button>
                        </PopoverTrigger>
                        <ProviderPopoverContent
                          aria-label={providerName(provider.id, provider.label)}
                          align="start"
                          collisionPadding={12}
                          className="max-h-[min(calc(100vh-48px),var(--radix-popover-content-available-height))] w-[min(360px,calc(100vw-24px))] overflow-y-auto"
                        >
                          <ProviderCard
                            provider={provider}
                            onReload={reloadProviders}
                            onOpenSettings={() => onProviderCard(null)}
                            onRestartHost={() => {
                              onProviderCard(null);
                              useUiStore.getState().confirmRestartHost();
                            }}
                          />
                        </ProviderPopoverContent>
                      </Popover>
                    );
                  })}
                </div>
                {models !== null && models.length > 0 ? (
                  <Select
                    value={displayedModel ?? DEFAULT_MODEL}
                    disabled={rowLocked}
                    onValueChange={(value) => {
                      const model = value === DEFAULT_MODEL ? null : value;
                      // Уровня, которого у новой модели нет, больше не выбрать — он сбрасывается в `Default` (спека 5.9).
                      onUpdate(row.key, { model, modelTouched: true, effort: chosenEffort({ model, effort: row.effort }, info) });
                    }}
                  >
                    <SelectTrigger aria-label={text.modelField} className="min-w-[120px] flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={LIST_HEIGHT}>
                      <SelectItem value={DEFAULT_MODEL} className={ITEM_CLIP}>
                        {text.modelDefault}
                      </SelectItem>
                      {displayedModel !== null && !models.some(model => model.id === displayedModel) ? <SelectItem value={displayedModel}>{displayedModel}</SelectItem> : null}
                      {models.map((model) => (
                        <SelectItem key={model.id} value={model.id} className={ITEM_CLIP}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}
                {!row.effortTouched && roleEffort !== null && !roleEffortListed ? <span data-role-effort className="text-xs text-muted-foreground">{S.roles.defaultEffort(roleEffort)}</span> : null}
                <div className="ml-auto flex items-center gap-2">
                {efforts === null ? null : (
                  <Select
                    value={displayedEffort ?? DEFAULT_EFFORT}
                    disabled={rowLocked}
                    onValueChange={(value) => onUpdate(row.key, { effort: value === DEFAULT_EFFORT ? null : value, effortTouched: true })}
                  >
                    {/* Ширина постоянная: длинная подпись уровня не сдвигает модель и не выталкивает строку из окна 800×500. */}
                    <SelectTrigger aria-label={text.effortField} className="w-32 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={LIST_HEIGHT}>
                      <SelectItem value={DEFAULT_EFFORT} className={ITEM_CLIP}>
                        {text.effortDefault}
                      </SelectItem>
                      {efforts.map((level) => (
                        <SelectItem key={level.id} value={level.id} description={level.description} className={ITEM_CLIP}>
                          {level.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {showRowWorktree ? (
                  <button
                    type="button"
                    title={S.recipes.worktreeField}
                    aria-label={S.recipes.worktreeField}
                    aria-pressed={wantsWorktree(row, worktree)}
                    disabled={!worktreeAvailable || rowLocked}
                    onClick={() => onUpdate(row.key, { worktree: !wantsWorktree(row, worktree) })}
                    className={cn(
                      'inline-flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10 disabled:pointer-events-none disabled:opacity-35',
                      wantsWorktree(row, worktree) ? 'text-ring' : 'text-neutral-600',
                    )}
                  >
                    <GitBranch className="size-[15px]" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  title={text.removeAgent}
                  aria-label={text.removeAgent}
                  disabled={agents.length <= minRows || groupLocked}
                  onClick={() => onRemove(row.key)}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-800 hover:bg-foreground/10 disabled:pointer-events-none disabled:opacity-35"
                >
                  <X className="size-[15px]" aria-hidden="true" />
                </button>
                </div>
              </div>
              {row.roleMissing === null ? null : (
                <p role="status" data-role-missing className="min-w-0 break-words text-xs text-destructive">{S.recipes.roleMissing(row.roleMissing)}</p>
              )}
              {result === undefined ? null : (
                <p
                  role="status"
                  className={cn('min-w-0 break-words text-xs', result.status === 'failed' ? 'text-destructive' : 'text-neutral-700')}
                >
                  {result.status === 'started' ? text.agentStarted(sessionTag(result.sessionId)) : result.message}
                </p>
              )}
            </div>
          );
        })}
        <Button type="button" variant="outline" disabled={groupLocked} onClick={onAdd} className="self-start">
          <Plus className="size-[13px]" aria-hidden="true" />
          {text.addAgent}
        </Button>
      </div>
    </div>
  );
}
