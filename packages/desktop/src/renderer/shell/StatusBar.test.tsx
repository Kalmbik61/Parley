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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HostStatus } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useProvidersStore, type ProviderInfo } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';

afterEach(cleanup);
beforeEach(() => {
  useUiStore.getState().closeRestartHostDialog();
  useProvidersStore.setState({ providers: [] });
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
  it('сегмент на провайдера с available: true, в порядке ответа хоста; недоступные не показываются', () => {
    useProvidersStore.setState({
      providers: [
        provider({ id: 'codex', label: 'Codex', version: '0.44.0' }),
        provider({ id: 'gemini', label: 'Gemini CLI', available: false }),
        provider({ id: 'claude', label: 'Claude', version: '2.1.276' }),
      ],
    });
    const { container } = renderPlain();
    expect(segments(container).map((el) => el.getAttribute('data-provider-segment'))).toEqual(['codex', 'claude']);
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
    expect(claude?.className).toContain('gap-[7px]');
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
    expect(segments(container)[0]?.textContent).toBe('GGemini CLI1.2.3');
    expect(segments(container)[0]?.querySelector('img')).toBeNull();
  });

  it('провайдеров нет (метода нет, отказ) — сегментов нет, остальная строка на месте', () => {
    const { container } = renderPlain({ noticeLine: 'Что-то случилось' });
    expect(segments(container)).toHaveLength(0);
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
    const { container } = renderPlain({ noticeLine: long });
    expect(screen.getByText(long.trim()).className).toContain('truncate');
    expect(screen.getByText(long.trim()).className).toContain('min-w-0');
    expect(segments(container)[0]?.className).toContain('shrink-0');
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
