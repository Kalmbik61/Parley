/**
 * Строка статуса Organic (спека окна 2026-09-29, 1.1, решение 3): слева — сегменты провайдеров (значок,
 * имя, версия CLI), справа — сегменты спеки Orca-UI 5.9: уведомление хоста, счётчики внимания, связь с
 * хостом, «Host is outdated», будильник. Провайдеров даёт `store/providers.ts`.
 *
 * Тест 12 куска 3.1: хост старее окна — сегмент «Host is outdated — restart»,
 * клик спрашивает подтверждение, `Restart` зовёт `onRestartHost` один раз,
 * `Cancel` — ни разу. С полным `REQUIRED_METHODS` сегмента нет.
 *
 * С куска 6.3 подтверждение — в сторе (`dialogs.restartHost`), как у действия палитры
 * `host.restart`: строка статуса открывает его через `onRestartHostOpenChange`.
 *
 * Кусок 9b: лимиты подписок в сегменте провайдера (спека комнат Organic, 3.5) — полоска и
 * `58% 5h · 41% wk` после версии, тултип, порог 80 %.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { encodeIpcError } from '../../shared/ipc-error.js';
import type { LimitWindow, ProviderLimits } from '@parley/protocol';
import type { HostStatus } from '../../shared/bridge.js';
import { errorText, S } from '../../shared/strings.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore, type ProviderInfo } from '../store/providers.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from '../store/ui.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(toast).mockClear(); });
beforeEach(() => {
  useUiStore.getState().closeRestartHostDialog();
  useProvidersStore.setState({ providers: [], refreshing: false });
  useHostStore.setState({ appVersion: null });
});

/** Строка статуса с подтверждением из стора — так её подключает `AppShell`. */
function BoundStatusBar(props: Omit<StatusBarProps, 'restartHostOpen' | 'onRestartHostOpenChange'>): JSX.Element {
  const open = useUiStore((state) => state.dialogs.restartHost);
  return (
    <StatusBar
      {...props}
      restartHostOpen={open}
      onRestartHostOpenChange={(next) =>
        next ? useUiStore.getState().confirmRestartHost() : useUiStore.getState().closeRestartHostDialog()
      }
    />
  );
}

function renderBar(status: HostStatus, onRestartHost = vi.fn()) {
  render(
    <BoundStatusBar
      status={status}
      noticeLine=""
      wakePaused={false}
      onToggleWake={() => {}}
      onRestartHost={onRestartHost}
      attention={{ needsYou: 0, unseen: 0 }}
      onNextAttention={() => {}}
    />,
  );
  return onRestartHost;
}

const old: HostStatus = { state: 'connected', hostVersion: '1.0.0', methods: null };

describe('StatusBar: хост от другой сборки окна (0.2.0)', () => {
  const full: HostStatus = {
    state: 'connected',
    hostVersion: '0.1.0',
    methods: [...REQUIRED_METHODS],
  };

  it('методов хватает, но версия хоста не окна — тот же сегмент «Host is outdated — restart»', () => {
    useHostStore.setState({ appVersion: '0.2.0' });
    renderBar(full);
    expect(screen.getByRole('button', { name: S.statusBar.hostOutdated })).toBeTruthy();
  });

  it('та же сборка или версия окна ещё не пришла — сегмента нет', () => {
    useHostStore.setState({ appVersion: '0.1.0' });
    renderBar(full);
    expect(screen.queryByRole('button', { name: S.statusBar.hostOutdated })).toBeNull();
    cleanup();
    useHostStore.setState({ appVersion: null });
    renderBar(full);
    expect(screen.queryByRole('button', { name: S.statusBar.hostOutdated })).toBeNull();
  });
});

describe('StatusBar: хост старее окна', () => {
  it('Restart в подтверждении зовёт onRestartHost один раз', () => {
    const onRestartHost = renderBar(old);
    fireEvent.click(screen.getByRole('button', { name: 'Host is outdated — restart' }));
    expect(screen.getByRole('dialog', { name: 'Restart host?' })).toBeTruthy();
    expect(screen.getByText(S.statusBar.restartHostDescription)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onRestartHost).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().dialogs.restartHost).toBe(false);
  });

  it('кнопка открывает подтверждение через стор — тот же диалог, что у действия host.restart (тест 8 куска 6.3)', () => {
    const onRestartHost = renderBar(old);
    fireEvent.click(screen.getByRole('button', { name: 'Host is outdated — restart' }));
    expect(useUiStore.getState().dialogs.restartHost).toBe(true);
    expect(onRestartHost).not.toHaveBeenCalled();
  });

  it('открытое в сторе подтверждение видно и при полном наборе методов (путь палитры)', () => {
    act(() => useUiStore.getState().confirmRestartHost());
    const onRestartHost = renderBar({ state: 'connected', hostVersion: '2.0.0', methods: [...REQUIRED_METHODS] });
    expect(screen.getByRole('dialog', { name: 'Restart host?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onRestartHost).toHaveBeenCalledTimes(1);
  });

  it('Cancel не зовёт onRestartHost', () => {
    const onRestartHost = renderBar(old);
    fireEvent.click(screen.getByRole('button', { name: 'Host is outdated — restart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onRestartHost).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['rooms.addMember', 'rooms.resolveProposal'])(
    'хост без %s (комнаты Organic) — «Host is outdated — restart»: перезапуск предлагается, а не молча прячутся функции',
    (missing) => {
      renderBar({ state: 'connected', hostVersion: '2.0.0', methods: REQUIRED_METHODS.filter((method) => method !== missing) });
      expect(screen.getByRole('button', { name: 'Host is outdated — restart' })).toBeTruthy();
    },
  );

  it('с полным REQUIRED_METHODS сегмента нет', () => {
    renderBar({ state: 'connected', hostVersion: '2.0.0', methods: [...REQUIRED_METHODS] });
    expect(screen.queryByRole('button', { name: 'Host is outdated — restart' })).toBeNull();
  });
});

// Тест 9 куска 4.2: сегмент внимания «N need you · M unseen» (спека 7.3, 7.6).
describe('StatusBar: внимание (тест 9 куска 4.2)', () => {
  const connected: HostStatus = { state: 'connected', hostVersion: '1.0.0', methods: [...REQUIRED_METHODS] };

  function renderAttention(attention: { needsYou: number; unseen: number; humanUnread?: number }, onNext = vi.fn()) {
    render(
      <BoundStatusBar
        status={connected}
        noticeLine=""
        wakePaused={false}
        onToggleWake={() => {}}
        onRestartHost={() => {}}
        attention={attention}
        onNextAttention={onNext}
      />,
    );
    return onNext;
  }

  it('needsYou 2, unseen 1 (писем 3) — «2 need you · 1 unseen»; клик зовёт onNextAttention один раз', () => {
    const onNext = renderAttention({ needsYou: 2, unseen: 1, humanUnread: 3 });
    const segment = screen.getByRole('button', { name: '2 need you · 1 unseen' });
    fireEvent.click(segment);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('needsYou 1, unseen 0 — «1 needs you»', () => {
    renderAttention({ needsYou: 1, unseen: 0 });
    expect(screen.getByRole('button', { name: '1 needs you' })).toBeTruthy();
  });

  it('unseen 3 — «3 unseen»; оба нуля — сегмента нет', () => {
    renderAttention({ needsYou: 0, unseen: 3 });
    expect(screen.getByRole('button', { name: '3 unseen' })).toBeTruthy();
    cleanup();
    renderAttention({ needsYou: 0, unseen: 0 });
    expect(document.querySelector('[data-attention-segment]')).toBeNull();
  });

  it('S.statusBar.attention', () => {
    expect(S.statusBar.attention(2, 1)).toBe('2 need you · 1 unseen');
    expect(S.statusBar.attention(1, 0)).toBe('1 needs you');
    expect(S.statusBar.attention(0, 3)).toBe('3 unseen');
    expect(S.statusBar.attention(0, 0)).toBe('');
  });
});

const provider = (patch: Partial<ProviderInfo> & Pick<ProviderInfo, 'id'>): ProviderInfo => ({
  label: patch.id,
  available: true,
  version: null,
  limits: null,
  ...patch,
});

function renderPlain(props: Partial<StatusBarProps> = {}) {
  return render(
    <BoundStatusBar
      status={{ state: 'connected', hostVersion: '1.0.0', methods: [...REQUIRED_METHODS] }}
      noticeLine=""
      wakePaused={false}
      onToggleWake={() => {}}
      onRestartHost={() => {}}
      attention={{ needsYou: 0, unseen: 0 }}
      onNextAttention={() => {}}
      {...props}
    />,
  );
}

const segments = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-provider-segment]')];

describe('StatusBar — провайдеры слева (Organic, 1.1)', () => {
  it.each([false, true])('основные кнопки в обеих темах открывают общую карточку; GLM лимитов не имеет (%s)', (dark) => {
    useUiStore.setState({ dark });
    useProvidersStore.setState({ providers: [provider({ id: 'glm', label: 'GLM', limits: { fiveHour: { usedPercent: 91, resetsAt: '2026-10-04T00:00:00Z' }, week: null, at: '2026-10-03T00:00:00Z' } })] });
    const { container } = renderPlain();
    expect(container.querySelector('[data-provider-segment="glm"] [data-limits]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'GLM — connected' }));
    expect(screen.getByRole('dialog', { name: 'GLM' })).toBeTruthy();
    expect(screen.getByText('Requires an active GLM Coding Plan.')).toBeTruthy();
  });
  it('Claude/Codex/GLM всегда в порядке продукта, за ними только найденные свои провайдеры', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'codex', label: 'Codex', version: '0.44.0' }),
        provider({ id: 'gemini', label: 'Gemini CLI', available: false }),
        provider({ id: 'claude', label: 'Claude', version: '2.1.276' }),
      ],
    });
    const { container } = renderPlain();
    expect(segments(container).map((el) => el.getAttribute('data-provider-segment'))).toEqual(['claude', 'codex', 'glm']);
  });

  it('недоступные сегменты приглушены, без not found, версии и лимитов; доступны с клавиатуры', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', version: '2.1.276' }),
        provider({ id: 'codex', label: 'Codex', available: false, version: '0.44.0' }),
        provider({ id: 'glm', label: 'GLM', available: false }),
      ],
    });
    const { container } = renderPlain();
    expect(segments(container).map((el) => el.getAttribute('data-provider-segment'))).toEqual([
      'claude',
      'codex',
      'glm',
    ]);
    const codex = segments(container)[1];
    // Версии и лимитов у ненайденного нет: версия из прошлой пробы о нынешнем CLI ничего не говорит.
    expect(codex?.textContent).toBe('Codex');
    expect(codex?.className).toContain('opacity-50');
    const button = screen.getByRole('button', { name: 'Codex — not connected. Click to connect' });
    expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(screen.queryByText('not found')).toBeNull();
  });

  it('значок 14, имя по handoff — «Claude Code» и «Codex», версия — моноширинным 11px neutral-700', () => {
    useProvidersStore.setState({
      providers: [provider({ id: 'claude', label: 'Claude', version: '2.1.276' }), provider({ id: 'codex', label: 'OpenAI Codex', version: '0.44.0' })],
    });
    const { container } = renderPlain();
    const [claude, codex] = segments(container);
    expect(claude?.textContent).toBe('Claude Code2.1.276');
    expect(codex?.textContent).toBe('Codex0.44.0');
    expect(claude?.querySelector('img')?.getAttribute('width')).toBe('14');
    expect(claude?.querySelector('img')?.getAttribute('src')).toMatch(/claude\.svg$/);
    const version = screen.getByText('2.1.276');
    expect(version.className).toContain('font-mono');
    expect(version.className).toContain('text-[11px]');
    expect(version.className).toContain('text-neutral-700');
    expect(claude?.tagName).toBe('BUTTON');
    expect(claude?.className).toContain('min-w-0');
  });

  it('версия null или нет поля (хост, переживший окно) — только значок и имя', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude', label: 'Claude', version: null })] });
    const { container } = renderPlain();
    expect(segments(container)[0]?.textContent).toBe('Claude Code');
    expect(segments(container)[0]?.querySelector('.font-mono')).toBeNull();
  });

  it('прочий провайдер — метка хоста и буквенный значок, как прежде', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'gemini', label: 'Gemini CLI', version: '1.2.3' })] });
    const { container } = renderPlain();
    expect(segments(container)[3]?.textContent).toBe('GGemini CLI1.2.3');
    expect(segments(container)[3]?.querySelector('img')).toBeNull();
  });

  it('пустой список старого хоста сохраняет три основные кнопки и остальную строку', () => {
    const { container } = renderPlain({ noticeLine: 'Что-то случилось' });
    expect(segments(container)).toHaveLength(3);
    expect(screen.getByText('Host 1.0.0')).toBeTruthy();
    expect(screen.getByText('Что-то случилось')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Auto-wake on' })).toBeTruthy();
  });

  it('провайдеры — слева от сегментов Orca-UI 5.9: в DOM раньше связи с хостом, уведомления, внимания и будильника', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude', label: 'Claude' })] });
    const { container } = renderPlain({ noticeLine: 'Уведомление', attention: { needsYou: 1, unseen: 0 } });
    const order = [
      container.querySelector('[data-provider-segment]'),
      screen.getByText('Уведомление'),
      screen.getByRole('button', { name: '1 needs you' }),
      screen.getByText('Host 1.0.0'),
      screen.getByRole('button', { name: 'Auto-wake on' }),
    ];
    for (let index = 1; index < order.length; index += 1) {
      const before = order[index - 1] as Node;
      const after = order[index] as Node;
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING, `${index}`).toBeTruthy();
    }
  });

  it('геометрия 1.1: 28px, без границы и подложки, 12px neutral-800, зазор 14, отступ 0 14 2 18', () => {
    const { container } = renderPlain();
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.className).toMatch(/\bh-7\b/);
    expect(bar.className).not.toMatch(/\bh-6\b/);
    expect(bar.className).not.toMatch(/\bborder-t\b/);
    expect(bar.className).not.toMatch(/\bbg-card\b/);
    expect(bar.className).toMatch(/\btext-xs\b/);
    expect(bar.className).toContain('text-neutral-800');
    expect(bar.className).toMatch(/\bgap-3\.5\b/);
    expect(bar.className).toContain('pl-[18px]');
    expect(bar.className).toMatch(/\bpr-3\.5\b/);
    expect(bar.className).toMatch(/\bpb-0\.5\b/);
  });

  it('длинное уведомление хоста обрезается многоточием и не выталкивает провайдеров и будильник', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude', label: 'Claude', version: '2.1.276' })] });
    const long = 'очень длинное уведомление '.repeat(20);
    renderPlain({ noticeLine: long });
    expect(screen.getByText(long.trim()).className).toContain('truncate');
    expect(screen.getByText(long.trim()).className).toContain('min-w-0');
    // Уведомление — заполнитель между провайдерами и правыми сегментами: берёт только то, что осталось.
    expect(screen.getByText(long.trim()).className).toContain('flex-1');
    expect(screen.getByRole('button', { name: 'Auto-wake on' }).className).toContain('shrink-0');
  });

  it('кнопки справа — пилюли с основным цветом на hover (наследство куска 1)', () => {
    renderPlain({ attention: { needsYou: 1, unseen: 0 } });
    for (const name of ['1 needs you', 'Auto-wake on']) {
      const button = screen.getByRole('button', { name });
      expect(button.className, name).toMatch(/\brounded-full\b/);
      expect(button.className, name).toContain('text-foreground');
      expect(button.className, name).toContain('hover:bg-foreground/8');
    }
  });
});

// ── Лимиты подписок в сегменте провайдера (кусок 9b; спека комнат Organic, 3.5, решения контролёра 1–3) ──

/** Окно лимита: `usedPercent` как отдал хост (дробное бывает), сброс — в будущем. */
const limitWindow = (usedPercent: number, resetsAt = '2026-09-29T21:30:00.000Z'): LimitWindow => ({ usedPercent, resetsAt });
const limitsOf = (patch: Partial<ProviderLimits>): ProviderLimits => ({
  fiveHour: null,
  week: null,
  at: '2026-09-29T18:20:00.000Z',
  ...patch,
});

const limitsIn = (container: HTMLElement, id = 'claude'): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-provider-segment="${id}"] [data-limits]`);
/** Заливка полоски — внутренняя, её ширина в процентах окна. */
const fillIn = (container: HTMLElement, id = 'claude'): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-provider-segment="${id}"] [data-limits-fill]`) as HTMLElement;

describe('S.statusBar.limitsText', () => {
  it('«58% 5h · 41% wk»; окна, которого нет, в тексте нет; оба отсутствуют — пусто', () => {
    expect(S.statusBar.limitsText(58, 41)).toBe('58% 5h · 41% wk');
    expect(S.statusBar.limitsText(58, null)).toBe('58% 5h');
    expect(S.statusBar.limitsText(null, 41)).toBe('41% wk');
    expect(S.statusBar.limitsText(null, null)).toBe('');
  });
});

describe('S.statusBar.limitsTooltip', () => {
  it('«5-hour window resets at {time} · Weekly window resets {day} {time} · Updated {time}»', () => {
    expect(S.statusBar.limitsTooltip('9:30 PM', { day: 'Sat', time: '9:05 AM' }, '6:20 PM')).toBe(
      '5-hour window resets at 9:30 PM · Weekly window resets Sat 9:05 AM · Updated 6:20 PM',
    );
  });

  it('только для окон, которые есть; «Updated» — всегда', () => {
    expect(S.statusBar.limitsTooltip('9:30 PM', null, '6:20 PM')).toBe('5-hour window resets at 9:30 PM · Updated 6:20 PM');
    expect(S.statusBar.limitsTooltip(null, { day: 'Sat', time: '9:05 AM' }, '6:20 PM')).toBe(
      'Weekly window resets Sat 9:05 AM · Updated 6:20 PM',
    );
    expect(S.statusBar.limitsTooltip(null, null, '6:20 PM')).toBe('Updated 6:20 PM');
  });
});

describe('StatusBar — лимиты подписок: сегмент провайдера (кусок 9b)', () => {
  it('два окна: после версии полоска и «58% 5h · 41% wk»', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', version: '2.1.276', limits: limitsOf({ fiveHour: limitWindow(58), week: limitWindow(41) }) }),
      ],
    });
    const { container } = renderPlain();
    expect(limitsIn(container)?.textContent).toBe('58% 5h · 41% wk');
    expect(segments(container)[0]?.textContent).toBe('Claude Code2.1.27658% 5h · 41% wk');
    // Полоска — внутри блока лимитов, перед текстом.
    const bar = limitsIn(container)?.firstElementChild as HTMLElement;
    expect(bar.querySelector('[data-limits-fill]')).toBe(fillIn(container));
    expect(bar.nextElementSibling?.textContent).toBe('58% 5h · 41% wk');
  });

  it('полоска — по прототипу: трек 44×4 пилюлей, 18 % текущего цвета, заливка на весь трек; отступ 4 и зазор 7', () => {
    useProvidersStore.setState({
      providers: [provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(58), week: limitWindow(41) }) })],
    });
    const { container } = renderPlain();
    const block = limitsIn(container) as HTMLElement;
    // От версии до полоски 4 + 7 = 11: зазор строки 14 и −3 у блока. Внутри блока зазор 7 — по горизонтали: блок переносит
    // строки, и зазор между строками ему не нужен.
    expect(block.className).toContain('ml-1');
    expect(block.className).toContain('gap-x-[7px]');
    expect(block.className).not.toMatch(/\bgap-\[/);
    const track = block.firstElementChild as HTMLElement;
    for (const cls of ['h-1', 'w-11', 'shrink-0', 'rounded-full', 'overflow-hidden', 'bg-current/18']) expect(track.className, cls).toContain(cls);
    // Полоска посреди строки в 16: без текста в первой строке (он ушёл на вторую) строка блока всё равно в высоту текста.
    expect(track.className).toContain('my-1.5');
    expect(track.getAttribute('aria-hidden')).toBe('true');
    expect(fillIn(container).className).toContain('h-full');
    expect(fillIn(container).className).toContain('rounded-full');
    expect(fillIn(container).style.width).toBe('58%');
  });

  it('текст лимитов — цифры одной ширины (tabular-nums), не переносится', () => {
    useProvidersStore.setState({
      providers: [provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(58) }) })],
    });
    renderPlain();
    const text = screen.getByText('58% 5h');
    expect(text.className).toContain('tabular-nums');
    expect(text.className).toContain('truncate');
  });

  it('одно окно показывается одно: только пятичасовое — «58% 5h», только недельное — «41% wk»', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(58) }) }),
        provider({ id: 'codex', label: 'Codex', limits: limitsOf({ week: limitWindow(41) }) }),
      ],
    });
    const { container } = renderPlain();
    expect(limitsIn(container, 'claude')?.textContent).toBe('58% 5h');
    expect(limitsIn(container, 'codex')?.textContent).toBe('41% wk');
  });

  it('полоска — пятичасовое окно; нет пятичасового — полоска недельного', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(58), week: limitWindow(41) }) }),
        provider({ id: 'codex', label: 'Codex', limits: limitsOf({ week: limitWindow(41) }) }),
      ],
    });
    const { container } = renderPlain();
    expect(fillIn(container, 'claude').style.width).toBe('58%');
    expect(fillIn(container, 'codex').style.width).toBe('41%');
  });

  it('нет данных — сегмент как прежде, значок, имя, версия: limits null, оба окна null и поля нет вовсе', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', version: '2.1.276', limits: null }),
        provider({ id: 'codex', label: 'Codex', version: '0.44.0', limits: limitsOf({}) }),
        // Хост без поля `limits`: в сторе `null`, но фикстура могла бы и не знать о поле.
        { id: 'gemini', label: 'Gemini CLI', available: true, version: '1.2.3' } as ProviderInfo,
      ],
    });
    const { container } = renderPlain();
    expect(container.querySelector('[data-limits]')).toBeNull();
    expect(segments(container).map((el) => el.textContent)).toEqual(['Claude Code2.1.276', 'Codex0.44.0', 'GGLM', 'GGemini CLI1.2.3']);
  });

  it('проценты целые, округление вниз: 58.7 → 58 %, 41.99 → 41 %, 99.9 → 99 %, 0.4 → 0 %; полоска по тому же числу', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(58.7), week: limitWindow(41.99) }) }),
        provider({ id: 'codex', label: 'Codex', limits: limitsOf({ fiveHour: limitWindow(99.9), week: limitWindow(0.4) }) }),
      ],
    });
    const { container } = renderPlain();
    expect(limitsIn(container, 'claude')?.textContent).toBe('58% 5h · 41% wk');
    expect(limitsIn(container, 'codex')?.textContent).toBe('99% 5h · 0% wk');
    expect(fillIn(container, 'claude').style.width).toBe('58%');
    expect(fillIn(container, 'codex').style.width).toBe('99%');
  });

  it('порог 80 %: 79 — обычные цвета, 80 — текст и полоска accent-700', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(79) }) }),
        provider({ id: 'codex', label: 'Codex', limits: limitsOf({ fiveHour: limitWindow(80) }) }),
      ],
    });
    const { container } = renderPlain();
    expect(screen.getByText('79% 5h').className).not.toContain('accent-700');
    expect(fillIn(container, 'claude').className).toContain('bg-neutral-800');
    expect(fillIn(container, 'claude').className).not.toContain('accent-700');
    expect(screen.getByText('80% 5h').className).toContain('text-accent-700');
    expect(fillIn(container, 'codex').className).toContain('bg-accent-700');
    expect(fillIn(container, 'codex').className).not.toContain('bg-neutral-800');
  });

  it('порог считается по показанному числу: 79.9 — «79 %», обычный цвет; 100 — предупреждение', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(79.9) }) }),
        provider({ id: 'codex', label: 'Codex', limits: limitsOf({ fiveHour: limitWindow(100) }) }),
      ],
    });
    renderPlain();
    expect(screen.getByText('79% 5h').className).not.toContain('accent-700');
    expect(screen.getByText('100% 5h').className).toContain('text-accent-700');
  });

  it('порог — «в любом окне»: 85 % в недельном красит и текст, и полоску пятичасового окна; и наоборот', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(10), week: limitWindow(85) }) }),
        provider({ id: 'codex', label: 'Codex', limits: limitsOf({ fiveHour: limitWindow(85), week: limitWindow(10) }) }),
      ],
    });
    const { container } = renderPlain();
    expect(screen.getByText('10% 5h · 85% wk').className).toContain('text-accent-700');
    expect(fillIn(container, 'claude').className).toContain('bg-accent-700');
    expect(fillIn(container, 'claude').style.width).toBe('10%');
    expect(screen.getByText('85% 5h · 10% wk').className).toContain('text-accent-700');
    expect(fillIn(container, 'codex').className).toContain('bg-accent-700');
  });

  it('предупреждение одного провайдера не красит другого', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: limitsOf({ fiveHour: limitWindow(58), week: limitWindow(41) }) }),
        provider({ id: 'codex', label: 'Codex', limits: limitsOf({ fiveHour: limitWindow(85) }) }),
      ],
    });
    const { container } = renderPlain();
    expect(screen.getByText('58% 5h · 41% wk').className).not.toContain('accent-700');
    expect(fillIn(container, 'claude').className).not.toContain('accent-700');
    expect(screen.getByText('85% 5h').className).toContain('text-accent-700');
  });

  it('событие providers.limitsChanged обновляет сегмент на месте: числа, порог, исчезновение', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({
      providers: [{ id: 'claude', label: 'Claude', available: true, version: '2.1.276', limits: limitsOf({ fiveHour: limitWindow(58), week: limitWindow(41) }) }],
    }));
    const dispose = useProvidersStore.getState().init(bridge);
    const { container } = renderPlain();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(limitsIn(container)?.textContent).toBe('58% 5h · 41% wk');

    act(() => bridge.emit('providers.limitsChanged', { id: 'claude', limits: limitsOf({ fiveHour: limitWindow(86.2), week: limitWindow(41) }) }));
    expect(limitsIn(container)?.textContent).toBe('86% 5h · 41% wk');
    expect(screen.getByText('86% 5h · 41% wk').className).toContain('text-accent-700');

    act(() => bridge.emit('providers.limitsChanged', { id: 'claude', limits: null }));
    expect(limitsIn(container)).toBeNull();
    expect(segments(container)[0]?.textContent).toBe('Claude Code2.1.276');
    dispose();
  });
});

// Тултип лимитов (кусок 9b): время локальное и короткое, «день» — день недели сброса недельного окна.
describe('StatusBar — лимиты подписок: тултип (кусок 9b)', () => {
  /** Момент по местному времени, как ISO: тест не зависит от часового пояса машины (`toISOString` — UTC, окно вернёт местное). */
  const local = (month: number, day: number, hour: number, minute: number): string => new Date(2026, month - 1, day, hour, minute).toISOString();
  /** Пробел перед AM/PM в зависимости от ICU бывает узким неразрывным — тест его не различает. */
  const spaced = (text: string | null | undefined): string => (text ?? '').replace(/\s/g, ' ');
  const titleOf = (container: HTMLElement, id = 'claude'): string => spaced(limitsIn(container, id)?.getAttribute('title'));

  const fiveHour = limitWindow(58, local(9, 29, 21, 30));
  // Суббота, 3 октября 2026.
  const week = limitWindow(41, local(10, 3, 9, 5));
  const at = local(9, 29, 18, 20);

  it('оба окна: «5-hour window resets at 9:30 PM · Weekly window resets Sat 9:05 AM · Updated 6:20 PM»', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude', label: 'Claude', limits: { fiveHour, week, at } })] });
    const { container } = renderPlain();
    expect(titleOf(container)).toBe('5-hour window resets at 9:30 PM · Weekly window resets Sat 9:05 AM · Updated 6:20 PM');
  });

  it('только пятичасовое — без недельной части', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude', label: 'Claude', limits: { fiveHour, week: null, at } })] });
    const { container } = renderPlain();
    expect(titleOf(container)).toBe('5-hour window resets at 9:30 PM · Updated 6:20 PM');
  });

  it('только недельное — без пятичасовой части', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude', label: 'Claude', limits: { fiveHour: null, week, at } })] });
    const { container } = renderPlain();
    expect(titleOf(container)).toBe('Weekly window resets Sat 9:05 AM · Updated 6:20 PM');
  });

  it('время — местное, а не UTC: полночь и полдень пишутся 12:05 AM и 12:00 PM', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'claude', label: 'Claude', limits: { fiveHour: limitWindow(58, local(9, 30, 0, 5)), week: limitWindow(41, local(10, 4, 12, 0)), at } }),
      ],
    });
    const { container } = renderPlain();
    expect(titleOf(container)).toBe('5-hour window resets at 12:05 AM · Weekly window resets Sun 12:00 PM · Updated 6:20 PM');
  });

  it('у каждого провайдера свой тултип; событие обновляет и его: «Updated» — по новому at', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({
      providers: [
        { id: 'claude', label: 'Claude', available: true, version: null, limits: { fiveHour, week, at } },
        { id: 'codex', label: 'Codex', available: true, version: null, limits: { fiveHour: limitWindow(85, local(9, 29, 22, 0)), week: null, at: local(9, 29, 18, 25) } },
      ],
    }));
    const dispose = useProvidersStore.getState().init(bridge);
    const { container } = renderPlain();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(titleOf(container, 'codex')).toBe('5-hour window resets at 10:00 PM · Updated 6:25 PM');

    act(() => bridge.emit('providers.limitsChanged', { id: 'claude', limits: { fiveHour, week, at: local(9, 29, 19, 41) } }));
    expect(titleOf(container, 'claude')).toBe('5-hour window resets at 9:30 PM · Weekly window resets Sat 9:05 AM · Updated 7:41 PM');
    expect(titleOf(container, 'codex')).toBe('5-hour window resets at 10:00 PM · Updated 6:25 PM');
    dispose();
  });
});

// Длинные значения (кусок 9b, решение контролёра 3): в 800×500 имя и версия провайдера не выталкивают лимиты, при
// нехватке места первым сжимается текст лимитов (многоточие), полоска остаётся, правые сегменты не уезжают. Вёрстку
// jsdom не считает — здесь классы; геометрию в живом окне проверяют E2E `limits.spec.ts`.
describe('StatusBar — длинные значения (кусок 9b)', () => {
  const both = limitsOf({ fiveHour: limitWindow(58), week: limitWindow(41) });
  const long = { id: 'zeta', label: 'Extremely Long Provider Label For The Status Bar Layout Check', version: '123456789.987654321.123456789' };

  it('сегмент — фокусируемая кнопка с ограничением ширины и сжимаемыми частями', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both }), provider({ id: 'codex', label: 'Codex' })] });
    const { container } = renderPlain();
    const zeta = container.querySelector<HTMLElement>('[data-provider-segment="zeta"]')!;
    const codex = container.querySelector<HTMLElement>('[data-provider-segment="codex"]')!;
    expect(zeta?.tagName).toBe('BUTTON');
    expect(zeta?.className).toContain('min-w-0');
    expect(codex?.className).toContain('min-w-0');
    const bar = container.firstElementChild as HTMLElement;
    expect(zeta?.parentElement).toBe(bar);
    expect(zeta?.children).toHaveLength(4);
    // У провайдера без данных лимитов сжимать нечего: значок и имя, без блока лимитов.
    expect(codex?.children).toHaveLength(2);
  });

  it('имя и версия — с многоточием (min-w-0 truncate), значок не сжимается', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both })] });
    const { container } = renderPlain();
    const segment = segments(container)[0] as HTMLElement;
    for (const el of [screen.getByText(long.label), screen.getByText(long.version)]) {
      expect(el.className).toContain('min-w-0');
      expect(el.className).toContain('truncate');
    }
    expect(segment.querySelector('[data-agent-icon]')?.className).toContain('shrink-0');
  });

  it('порядок сжатия строгий: веса на порядки — сначала лимиты, потом версия, имя провайдера теряется последним', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both })] });
    const { container } = renderPlain();
    // Вес `flex-shrink`: нет класса — 1. Доли нехватки делятся пропорционально вес × ширина, поэтому «первым» значит «на
    // порядки больше»: при малом разрыве (вес 100 против 10) многоточие на имени вылезало бы уже при нехватке в пару пикселей.
    const weight = (el: Element): number => Number(/\bshrink-\[(\d+)\]/.exec(el.className)?.[1] ?? 1);
    const limitsWeight = weight(limitsIn(container, 'zeta') as HTMLElement);
    const versionWeight = weight(screen.getByText(long.version));
    const nameWeight = weight(screen.getByText(long.label));
    expect(nameWeight).toBe(1);
    expect(versionWeight).toBeGreaterThanOrEqual(nameWeight * 10_000);
    expect(limitsWeight).toBeGreaterThanOrEqual(versionWeight * 10_000);
  });

  it('у имени и версии нет потолков ширины: длинная метка показывается целиком, пока место есть; порядок сжатия держат веса и min-w-0', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both })] });
    renderPlain();
    for (const el of [screen.getByText(long.label), screen.getByText(long.version)]) {
      // Потолок резал бы имя и в широком окне, при свободном месте; сжимать — дело `flex-shrink`.
      expect(el.className).not.toMatch(/\bmax-w-/);
      expect(el.className).toContain('min-w-0');
      expect(el.className).toContain('truncate');
    }
  });

  it('лимиты: сжимается блок с текстом (многоточие); полоска не сжимается и остаётся даже при нулевом тексте', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both })] });
    const { container } = renderPlain();
    const block = limitsIn(container, 'zeta') as HTMLElement;
    expect(block.className).toMatch(/\bshrink-\[\d+\]/);
    // Меньше полоски (трека 44) блок не бывает: полоска остаётся, даже когда текст спрятан целиком.
    expect(block.className).toContain('min-w-11');
    expect(block.className).not.toContain('min-w-[51px]');
    const [bar, text] = [...block.children] as HTMLElement[];
    expect(bar?.className).toContain('shrink-0');
    expect(text?.className).toContain('min-w-0');
    expect(text?.className).toContain('truncate');
  });

  // Chromium при `text-overflow: ellipsis` всегда оставляет первый знак, даже если многоточие рядом с ним не помещается:
  // от «85% 5h» в узком блоке оставалась одна цифра «8» (Figtree 12px: цифра 6.9 px, многоточие 7.4 px). Вёрстка блока
  // не даёт тексту стать обрывком: текст с основой «58% и многоточие» (4.5ch ≈ 35 px) не помещается в первую строку блока,
  // когда блок уже, и переносится на вторую, а блок высотой в одну строку её обрезает — текст пропадает целиком, полоска
  // остаётся. Перенос считает настоящая вёрстка, jsdom её не видит — поведение проверяет E2E `limits.spec.ts`.
  it('текст лимитов не бывает обрывком: блок переносит строки, вторая обрезана; у текста основа под «58%» и многоточие', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both })] });
    const { container } = renderPlain();
    const block = limitsIn(container, 'zeta') as HTMLElement;
    for (const cls of ['flex-wrap', 'content-start', 'h-4', 'overflow-hidden']) expect(block.className, cls).toMatch(new RegExp(`(^|\\s)${cls}(\\s|$)`));
    const text = block.lastElementChild as HTMLElement;
    // Основа — в переносе строк вместо самого текста: на первой строке текст занимает не меньше основы, дальше растёт.
    expect(text.className).toContain('basis-[4.5ch]');
    expect(text.className).toMatch(/(^|\s)grow(\s|$)/);
    expect(text.className).toContain('min-w-0');
    expect(text.className).toContain('truncate');
  });

  it('правые сегменты — одним блоком, который не сжимается и не уезжает: внимание, связь с хостом, «Host is outdated», будильник', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both })] });
    renderPlain({ attention: { needsYou: 2, unseen: 1 } });
    const cluster = screen.getByRole('button', { name: 'Auto-wake on' }).parentElement as HTMLElement;
    expect(cluster.className).toContain('shrink-0');
    expect(screen.getByRole('button', { name: '2 need you · 1 unseen' }).parentElement).toBe(cluster);
    expect(screen.getByText('Host 1.0.0').parentElement).toBe(cluster);
  });

  it('уведомление — заполнитель между провайдерами и правым блоком: то же общее место в строке, а не внутри блока', () => {
    useProvidersStore.setState({ providers: [provider({ ...long, limits: both })] });
    const { container } = renderPlain({ noticeLine: 'Что-то случилось' });
    const bar = container.firstElementChild as HTMLElement;
    const notice = screen.getByText('Что-то случилось');
    expect(notice.parentElement).toBe(bar);
    expect(notice.className).toContain('flex-1');
    expect(notice.className).toContain('text-right');
    expect(notice.nextElementSibling).toBe(screen.getByRole('button', { name: 'Auto-wake on' }).parentElement);
  });
});


describe('StatusBar — ручное обновление лимитов', () => {
  const connected: HostStatus = { state: 'connected', hostVersion: '1.0.0', methods: [...REQUIRED_METHODS, 'providers.refreshLimits'] };

  it('кнопка обновления стоит самым первым элементом строки и доступна с клавиатуры', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude' })] });
    const { container } = renderPlain({ status: connected });
    const button = screen.getByRole('button', { name: 'Refresh provider limits' });
    expect(container.firstElementChild?.firstElementChild).toBe(button);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('title')).toBe('Refresh provider limits');
  });

  it.each<HostStatus>([
    { state: 'connecting' },
    { state: 'disconnected', reason: 'closed' },
    { state: 'mismatch', hostVersion: '9.0.0', liveSessions: 0 },
    { state: 'connected', hostVersion: '1.0.0', methods: null },
    { state: 'connected', hostVersion: '1.0.0', methods: REQUIRED_METHODS.filter((method) => method !== 'providers.refreshLimits') },
  ])('обновление отключено без доступного метода или связи ($state)', (status) => {
    useProvidersStore.setState({ providers: [provider({ id: 'claude' })] });
    renderPlain({ status });
    expect((screen.getByRole('button', { name: 'Refresh provider limits' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('без подключённых провайдеров кнопка недоступна', () => {
    renderPlain({ status: connected });
    expect((screen.getByRole('button', { name: 'Refresh provider limits' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('хосту той же версии без нового метода предлагает существующее подтверждение перезапуска', () => {
    useHostStore.setState({ appVersion: '1.0.0' });
    useProvidersStore.setState({ providers: [provider({ id: 'claude' })] });
    const restart = vi.fn();
    renderPlain({ status: { ...connected, methods: REQUIRED_METHODS.filter((method) => method !== 'providers.refreshLimits') }, onRestartHost: restart });
    fireEvent.click(screen.getByRole('button', { name: S.statusBar.hostOutdated }));
    expect(screen.getByRole('dialog', { name: S.statusBar.restartHostTitle })).toBeTruthy();
    expect(restart).not.toHaveBeenCalled();
  });

  it('ручной клик вызывает обновление, показывает busy и блокирует повторный клик до нового снимка', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'claude' })] }));
    let resolve!: (value: { ok: true }) => void;
    bridge.setHandler('providers.refreshLimits', () => new Promise((yes) => { resolve = yes; }));
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    renderPlain({ status: connected });
    const button = screen.getByRole('button', { name: 'Refresh provider limits' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
    fireEvent.click(button);
    expect(bridge.calls.filter(({ method }) => method === 'providers.refreshLimits')).toHaveLength(1);
    await act(async () => { resolve({ ok: true }); await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(600); });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(bridge.hostActions).toEqual([]);
    dispose();
  });

  it('отказ показывает тост только из кода ошибки, без текста хоста и без перезапуска', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'glm' })] }));
    bridge.setHandler('providers.refreshLimits', () => { throw encodeIpcError({ code: 'internal', message: 'secret-token /private/path' }); });
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    renderPlain({ status: connected });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh provider limits' })); });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0]?.[0]).toContain("Couldn't refresh provider limits");
    expect(vi.mocked(toast).mock.calls[0]?.[0]).not.toMatch(/secret-token|private/);
    expect(bridge.hostActions).toEqual([]);
    dispose();
  });


  it.each([
    ['authentication', 'Z.ai rejected the saved key (401). Open GLM and replace it with your full Z.ai API key.'],
    ['unsupported_response', 'The current Z.ai quota response is not supported.'],
    ['timeout', 'The Z.ai quota request timed out. Try again.'],
    ['unavailable', 'Z.ai quota is temporarily unavailable. Try again.'],
  ])('точная причина GLM %s показывает фиксированную строку без сырого ответа', async (reason, expected) => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    let percent = 42;
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'claude', limits: limitsOf({ fiveHour: limitWindow(percent) }) })] }));
    bridge.setHandler('providers.refreshLimits', () => {
      percent = 57;
      throw encodeIpcError({ code: 'internal', message: 'raw-secret /private/path', data: {
        provider: 'glm', reason, body: 'upstream-secret', cause: 'raw-cause',
      } });
    });
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    renderPlain({ status: connected });
    const button = screen.getByRole('button', { name: 'Refresh provider limits' }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(button); });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expected);
    expect(useProvidersStore.getState().providers[0]?.limits?.fiveHour?.usedPercent).toBe(57);
    expect(button.disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(600); });
    expect(button.disabled).toBe(false);
    expect(bridge.hostActions).toEqual([]);
    dispose();
  });

  it.each([
    { code: 'internal', data: { provider: 'glm', reason: 'upstream-secret' } },
    { code: 'internal', data: { provider: 'glm', reason: 'constructor' } },
    { code: 'internal', data: { provider: 'glm', reason: { message: 'upstream-secret' } } },
    { code: 'internal', data: { provider: 'other-secret', reason: 'authentication' } },
    { code: 'internal', data: { reason: 'authentication' } },
    { code: 'internal', data: { provider: 'glm' } },
    { code: 'internal', data: { provider: 'glm', reason: 'AUTHENTICATION' } },
    { code: 'bad_request', data: { provider: 'glm', reason: 'authentication' } },
  ])('неизвестная пара или код использует прежний безопасный fallback, вариант %#', async ({ code, data }) => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'glm' })] }));
    bridge.setHandler('providers.refreshLimits', () => { throw encodeIpcError({
      code, message: 'raw-secret /private/path', data: { ...data, body: 'upstream-secret' },
    }); });
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    renderPlain({ status: connected });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh provider limits' })); });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(errorText(code, S.errors.actions.refreshProviderLimits));
    expect(vi.mocked(toast).mock.calls[0]?.[0]).not.toMatch(/raw-secret|private|upstream-secret|other-secret/);
    dispose();
  });

  it.each([false, true])('быстрый ответ оставляет видимый отклик на 600 ms без задержки данных/ошибки (%s)', async (fails) => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    let percent = 42;
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'claude', limits: limitsOf({ fiveHour: limitWindow(percent) }) })] }));
    bridge.setHandler('providers.refreshLimits', () => {
      percent = 57;
      if (fails) throw encodeIpcError({ code: 'internal', message: 'private text' });
      return { ok: true };
    });
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    renderPlain({ status: connected });
    const button = screen.getByRole('button', { name: 'Refresh provider limits' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.lucide-refresh-cw')?.classList.contains('animate-spin')).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(useProvidersStore.getState().refreshing).toBe(false);
    expect(useProvidersStore.getState().providers[0]?.limits?.fiveHour?.usedPercent).toBe(57);
    expect(toast).toHaveBeenCalledTimes(fails ? 1 : 0);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(bridge.calls.filter(({ method }) => method === 'providers.refreshLimits')).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(599); });
    expect(button.getAttribute('aria-busy')).toBe('true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.querySelector('.animate-spin')).toBeNull();
    dispose();
  });

  it('долгий запрос продолжает вращение после минимального отклика до ответа хоста', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'claude' })] }));
    let resolve!: (value: { ok: true }) => void;
    bridge.setHandler('providers.refreshLimits', () => new Promise((yes) => { resolve = yes; }));
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    renderPlain({ status: connected });
    const button = screen.getByRole('button', { name: 'Refresh provider limits' }) as HTMLButtonElement;
    fireEvent.click(button);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(button.disabled).toBe(true);
    expect(button.querySelector('.animate-spin')).toBeTruthy();
    await act(async () => { resolve({ ok: true }); });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    dispose();
  });

  it('при reduced motion вращение скрыто, а неподвижные песочные часы и фон показывают busy', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'claude' })] }));
    bridge.setHandler('providers.refreshLimits', () => ({ ok: true }));
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    renderPlain({ status: connected });
    const button = screen.getByRole('button', { name: 'Refresh provider limits' });
    fireEvent.click(button);
    expect(button.querySelector('.lucide-refresh-cw')?.classList.contains('motion-reduce:hidden')).toBe(true);
    const still = button.querySelector('.lucide-hourglass');
    expect(still?.classList.contains('hidden')).toBe(true);
    expect(still?.classList.contains('motion-reduce:block')).toBe(true);
    expect(still?.classList.contains('animate-spin')).toBe(false);
    expect(button.classList.contains('bg-foreground/8')).toBe(true);
    await act(async () => { await Promise.resolve(); });
    dispose();
  });

  it('переподключение сбрасывает местный отклик, а размонтирование очищает таймер', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'claude' })] }));
    bridge.setHandler('providers.refreshLimits', () => ({ ok: true }));
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    const view = renderPlain({ status: connected });
    const button = screen.getByRole('button', { name: 'Refresh provider limits' }) as HTMLButtonElement;
    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(button.disabled).toBe(true);
    act(() => { useHostStore.setState((state) => ({ connections: state.connections + 1 })); });
    expect(button.disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('поздняя ошибка размонтированной кнопки не показывает тост', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', () => ({ providers: [provider({ id: 'claude' })] }));
    let reject!: (error: unknown) => void;
    bridge.setHandler('providers.refreshLimits', () => new Promise((_yes, no) => { reject = no; }));
    const dispose = useProvidersStore.getState().init(bridge);
    await act(async () => { await Promise.resolve(); });
    const view = renderPlain({ status: connected });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh provider limits' }));
    view.unmount();
    await act(async () => { reject(encodeIpcError({ code: 'internal', message: 'old error' })); });
    expect(toast).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('показывает подтверждённые квоты Z.ai даже с неизвестным временем сброса', () => {
    useProvidersStore.setState({ providers: [provider({ id: 'glm', limits: limitsOf({ source: 'zai', fiveHour: { usedPercent: 42.9, resetsAt: null } }) })] });
    const { container } = renderPlain();
    expect(limitsIn(container, 'glm')?.textContent).toBe('42% 5h');
    expect(fillIn(container, 'glm').style.width).toBe('42%');
    expect(limitsIn(container, 'glm')?.title).toMatch(/^Updated /);
    expect(limitsIn(container, 'glm')?.title).not.toMatch(/Invalid|resets|1970/);
  });
});
