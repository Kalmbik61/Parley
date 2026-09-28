/**
 * Тесты 2 и 3 куска 1.2 плана: `AgentStateDot` по всем девяти строкам таблицы
 * спеки 4.2 (данные и значок различаются по `data-state`/`data-testid`) и
 * общая фаза кольца `working` (`spinnerDelayMs`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AgentStateDot } from './AgentStateDot.js';
import { spinnerDelayMs } from './AgentWorkingSpinner.js';
import { stateWord } from '../lib/dot-state.js';

afterEach(cleanup);

describe('AgentStateDot — тест 2, таблица спеки 4.2', () => {
  it('working — кольцо .agent-working-spinner, жёлтый цвет, целое при reduced motion', () => {
    const { getByTestId } = render(<AgentStateDot state="working" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-state')).toBe('working');
    expect(root.innerHTML).toContain('agent-working-spinner');
    expect(root.innerHTML).toContain('border-yellow-500');
    // Раунд исправлений 1 (находка A+B №1): без этого класса `prefers-reduced-
    // motion` останавливает вращение (styles/agent-spinner.css), но верхний
    // край кольца остаётся прозрачным (`border-t-transparent`) — застывший
    // разрыв читается как сломанный спиннер, а не как статичный маркер.
    expect(root.innerHTML).toContain('motion-reduce:border-t-yellow-500');
  });

  it('blocked — MessageCircleQuestion цвета --agent-question', () => {
    const { getByTestId } = render(<AgentStateDot state="blocked" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-state')).toBe('blocked');
    const icon = root.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('lucide-message-circle-question');
    expect(icon?.getAttribute('class')).toContain('text-agent-question');
  });

  it('unseen — точка emerald-500', () => {
    const { getByTestId } = render(<AgentStateDot state="unseen" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-state')).toBe('unseen');
    expect(root.querySelector('svg')).toBeNull();
    expect(root.innerHTML).toContain('bg-emerald-500');
  });

  it('idle — точка neutral-500/40', () => {
    const { getByTestId } = render(<AgentStateDot state="idle" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-state')).toBe('idle');
    expect(root.innerHTML).toContain('bg-neutral-500/40');
  });

  it('pending — полое кольцо neutral-500/60', () => {
    const { getByTestId } = render(<AgentStateDot state="pending" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-state')).toBe('pending');
    expect(root.innerHTML).toContain('border-neutral-500/60');
    expect(root.innerHTML).toContain('rounded-full');
  });

  it('exited + sleeping — Moon, data-lifecycle="sleeping"', () => {
    const { getByTestId } = render(<AgentStateDot state="exited" lifecycle="sleeping" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-state')).toBe('exited');
    expect(root.getAttribute('data-lifecycle')).toBe('sleeping');
    expect(root.querySelector('svg')?.getAttribute('class')).toContain('lucide-moon');
  });

  it('exited без lifecycle — тоже «спит» (значение по умолчанию)', () => {
    const { getByTestId } = render(<AgentStateDot state="exited" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-lifecycle')).toBe('sleeping');
    expect(root.querySelector('svg')?.getAttribute('class')).toContain('lucide-moon');
  });

  it('exited + closed — тире, без значка', () => {
    const { getByTestId } = render(<AgentStateDot state="exited" lifecycle="closed" />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('data-lifecycle')).toBe('closed');
    expect(root.querySelector('svg')).toBeNull();
    expect(root.textContent).toContain('–');
  });

  it('done — CircleCheck emerald-500', () => {
    const { getByTestId } = render(<AgentStateDot state="done" />);
    const root = getByTestId('agent-state-dot');
    const icon = root.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('lucide-circle-check');
    expect(icon?.getAttribute('class')).toContain('text-emerald-500');
  });

  it('failed — точка red-500', () => {
    const { getByTestId } = render(<AgentStateDot state="failed" />);
    const root = getByTestId('agent-state-dot');
    expect(root.querySelector('svg')).toBeNull();
    expect(root.innerHTML).toContain('bg-red-500');
  });

  it('size="sm" — контейнер 10px, size="md" (умолчание) — 12px', () => {
    const sm = render(<AgentStateDot state="idle" size="sm" />);
    expect(sm.getByTestId('agent-state-dot').className).toContain('size-2.5');
    sm.unmount();

    const md = render(<AgentStateDot state="idle" />);
    expect(md.getByTestId('agent-state-dot').className).toContain('size-3');
  });
});

describe('AgentStateDot — доступность (раунд исправлений 1, находка B №3)', () => {
  // Значок должен быть самодостаточен для скринридера независимо от того,
  // есть ли рядом текст-дублёр (на вкладке терминала, спека 5.3, его нет).
  it.each([
    ['working', 'active'],
    ['blocked', 'active'],
    ['unseen', 'active'],
    ['idle', 'active'],
    ['pending', 'pending'],
    ['exited', 'sleeping'],
    ['exited', 'closed'],
    ['done', 'closed'],
    ['failed', 'closed'],
  ] as const)('%s (%s) — role="img" и aria-label по stateWord', (state, lifecycle) => {
    const { getByTestId } = render(<AgentStateDot state={state} lifecycle={lifecycle} />);
    const root = getByTestId('agent-state-dot');
    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe(stateWord(state, lifecycle));
  });

  it('внутренний глиф working (кольцо) — aria-hidden, имя целиком на внешнем role="img"', () => {
    const { getByTestId } = render(<AgentStateDot state="working" />);
    const root = getByTestId('agent-state-dot');
    expect(root.querySelector('.agent-working-spinner')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('spinnerDelayMs — тест 3', () => {
  it('spinnerDelayMs(1234, 1000) → -234', () => {
    expect(spinnerDelayMs(1234, 1000)).toBe(-234);
  });

  it('два спиннера, смонтированные в разное время, — общий ноль фазы по модулю периода', () => {
    const period = 1000;
    const t1 = 5000;
    const t2 = 5432;
    const d1 = spinnerDelayMs(t1, period);
    const d2 = spinnerDelayMs(t2, period);
    // «Смонтирован + своя задержка» — всегда кратно периоду: оба выравниваются
    // на один и тот же ноль фазы независимо от момента монтирования (спека 4.2).
    expect((t1 + d1) % period).toBe(0);
    expect((t2 + d2) % period).toBe(0);
  });
});
