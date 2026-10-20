// packages/desktop/src/renderer/browser/agent-activity.test.ts
/**
 * Состояние значка и точки агента и одалживание фокуса (этап D, задача 20): чистое состояние по событиям
 * `browser:agent-activity` и перенос фокуса на `<webview>` с возвратом человеку (Фокус ревью 1 и 2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_LIMITS } from '@parley/protocol';
import { agentActivityOf, createFocusLender, isLendingFocus, resetAgentActivity, applyAgentActivity } from './agent-activity.js';

beforeEach(() => {
  vi.useFakeTimers();
  resetAgentRegistryStub();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function resetAgentRegistryStub(): void {
  resetAgentActivity();
}

describe('значок и точка по событиям', () => {
  it('start — значок с ярлыком; end — значок ещё guardTailMs; recent — последние badgeOps операций', () => {
    for (let i = 1; i <= AGENT_LIMITS.badgeOps + 2; i += 1) {
      applyAgentActivity({ webContentsId: 7, session: 'S01', op: `op${i}`, phase: 'start' });
      applyAgentActivity({ webContentsId: 7, session: 'S01', op: `op${i}`, phase: 'end' });
    }
    applyAgentActivity({ webContentsId: 7, session: 'S01', op: 'last', phase: 'start' });
    const now = agentActivityOf(7);
    expect(now.acting?.session).toBe('S01');
    expect(now.acting?.recent).toHaveLength(AGENT_LIMITS.badgeOps);
    expect(now.acting?.recent.at(-1)).toBe('last');
    applyAgentActivity({ webContentsId: 7, session: 'S01', op: 'last', phase: 'end' });
    expect(agentActivityOf(7).acting).not.toBeNull();
    vi.advanceTimersByTime(AGENT_LIMITS.guardTailMs);
    expect(agentActivityOf(7).acting).toBeNull();
  });

  it('новая операция в хвосте отменяет снятие значка', () => {
    applyAgentActivity({ webContentsId: 7, session: 'S01', op: 'a', phase: 'start' });
    applyAgentActivity({ webContentsId: 7, session: 'S01', op: 'a', phase: 'end' });
    vi.advanceTimersByTime(AGENT_LIMITS.guardTailMs - 100);
    applyAgentActivity({ webContentsId: 7, session: 'S01', op: 'b', phase: 'start' });
    vi.advanceTimersByTime(500);
    expect(agentActivityOf(7).acting).not.toBeNull();
  });

  it('step с point — точка на clickDotMs; point уже в пикселях <webview>', () => {
    applyAgentActivity({ webContentsId: 7, session: 'S01', op: 'action', phase: 'start' });
    applyAgentActivity({ webContentsId: 7, session: 'S01', op: 'action', phase: 'step', point: { x: 12, y: 34 } });
    expect(agentActivityOf(7).dot).toEqual({ x: 12, y: 34 });
    vi.advanceTimersByTime(AGENT_LIMITS.clickDotMs);
    expect(agentActivityOf(7).dot).toBeNull();
  });

  it('гость без событий — значка и точки нет', () => {
    expect(agentActivityOf(99)).toEqual({ acting: null, dot: null });
    expect(agentActivityOf(null)).toEqual({ acting: null, dot: null });
  });
});

describe('одалживание фокуса', () => {
  it('одолжить фокус (Фокус ревью 1): фокус на <webview>, ready(id, true), флаг одалживания; restore — фокус прежнему элементу, флаг снят', () => {
    const chat = document.createElement('textarea');
    document.body.append(chat);
    chat.focus();
    const view = document.createElement('div');
    view.tabIndex = 0;
    document.body.append(view);
    const ready = vi.fn();
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready });
    lender.borrow('f-1');
    expect(document.activeElement).toBe(view);
    expect(ready).toHaveBeenCalledWith('f-1', true);
    expect(isLendingFocus(7)).toBe(true);
    lender.restore();
    expect(document.activeElement).toBe(chat);
    expect(isLendingFocus(7)).toBe(false);
  });

  it('скрытая страница (Фокус ревью 2, решение владельца 8): видимость не проверяется — фокус встал, ready(id, true), restore вернул его человеку; <webview> нет — ready(id, false), фокус человека на месте', () => {
    const chat = document.createElement('textarea');
    document.body.append(chat);
    chat.focus();
    const panel = document.createElement('div');
    panel.style.visibility = 'hidden';
    document.body.append(panel);
    const view = document.createElement('div');
    view.tabIndex = 0;
    panel.append(view);
    const ready = vi.fn();
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready });
    lender.borrow('f-2');
    expect(ready).toHaveBeenCalledWith('f-2', true);
    lender.restore();
    expect(document.activeElement).toBe(chat);
    createFocusLender({ view: () => null, webContentsId: 8, ready }).borrow('f-3');
    expect(ready).toHaveBeenCalledWith('f-3', false);
    expect(document.activeElement).toBe(chat);
    expect(isLendingFocus(8)).toBe(false);
  });

  it('restore не трогает фокус, если человек уже ушёл с <webview> сам', () => {
    const chat = document.createElement('textarea');
    const other = document.createElement('input');
    document.body.append(chat, other);
    chat.focus();
    const view = document.createElement('div');
    view.tabIndex = 0;
    document.body.append(view);
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready: vi.fn() });
    lender.borrow('f-4');
    other.focus();
    const spy = vi.spyOn(chat, 'focus');
    lender.restore();
    expect(spy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
    expect(isLendingFocus(7)).toBe(false);
  });

  it('фокус человека в <webview> его вкладки (E2E 22a, тест 3): borrow сначала снимает его (blur — фокус окну), затем ставит на <webview> агента; restore — blur агента, затем focus <webview> человека', () => {
    const human = document.createElement('webview');
    human.tabIndex = 0;
    const view = document.createElement('webview');
    view.tabIndex = 0;
    document.body.append(human, view);
    human.focus();
    const humanBlur = vi.spyOn(human, 'blur');
    const humanFocus = vi.spyOn(human, 'focus');
    const viewBlur = vi.spyOn(view, 'blur');
    const viewFocus = vi.spyOn(view, 'focus');
    const ready = vi.fn();
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready });
    lender.borrow('f-6');
    expect(humanBlur).toHaveBeenCalledTimes(1);
    expect(humanBlur.mock.invocationCallOrder[0]).toBeLessThan(viewFocus.mock.invocationCallOrder[0] as number);
    expect(document.activeElement).toBe(view);
    expect(ready).toHaveBeenCalledWith('f-6', true);
    lender.restore();
    expect(viewBlur).toHaveBeenCalledTimes(1);
    expect(viewBlur.mock.invocationCallOrder[0]).toBeLessThan(humanFocus.mock.invocationCallOrder[0] as number);
    expect(document.activeElement).toBe(human);
    expect(isLendingFocus(7)).toBe(false);
  });

  it('фокус человека в поле окна: blur не зовётся ни при borrow, ни при restore — фокус переходит прямо', () => {
    const chat = document.createElement('textarea');
    document.body.append(chat);
    chat.focus();
    const view = document.createElement('webview');
    view.tabIndex = 0;
    document.body.append(view);
    const chatBlur = vi.spyOn(chat, 'blur');
    const viewBlur = vi.spyOn(view, 'blur');
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready: vi.fn() });
    lender.borrow('f-7');
    expect(document.activeElement).toBe(view);
    lender.restore();
    expect(document.activeElement).toBe(chat);
    expect(chatBlur).not.toHaveBeenCalled();
    expect(viewBlur).not.toHaveBeenCalled();
  });

  it('фокус на <webview> агента не встал после blur гостя человека — ready(id, false), фокус вернулся в <webview> человека', () => {
    const human = document.createElement('webview');
    human.tabIndex = 0;
    document.body.append(human);
    human.focus();
    // Без tabindex элемент фокус не берёт — как `<webview>`, который окно не может сфокусировать.
    const view = document.createElement('webview');
    document.body.append(view);
    const ready = vi.fn();
    createFocusLender({ view: () => view, webContentsId: 7, ready }).borrow('f-8');
    expect(ready).toHaveBeenCalledWith('f-8', false);
    expect(document.activeElement).toBe(human);
    expect(isLendingFocus(7)).toBe(false);
  });

  it('фокус был на body (человек кликнул в нефокусируемое место): restore снимает фокус с <webview> агента (финальная рецензия M1)', () => {
    const view = document.createElement('webview');
    view.tabIndex = 0;
    document.body.append(view);
    expect(document.activeElement).toBe(document.body);
    const viewBlur = vi.spyOn(view, 'blur');
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready: vi.fn() });
    lender.borrow('f-9');
    expect(document.activeElement).toBe(view);
    lender.restore();
    expect(viewBlur).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(view);
    expect(isLendingFocus(7)).toBe(false);
  });

  it('прежний элемент удалён за время операции (поле Chat перемонтировалось): restore снимает фокус с <webview> агента (финальная рецензия M1)', () => {
    const chat = document.createElement('textarea');
    document.body.append(chat);
    chat.focus();
    const view = document.createElement('webview');
    view.tabIndex = 0;
    document.body.append(view);
    const viewBlur = vi.spyOn(view, 'blur');
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready: vi.fn() });
    lender.borrow('f-10');
    chat.remove();
    lender.restore();
    expect(viewBlur).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(view);
  });

  it('человек сам был в странице агента или фокус не одалживали: restore фокус с <webview> не снимает', () => {
    const view = document.createElement('webview');
    view.tabIndex = 0;
    document.body.append(view);
    view.focus();
    const viewBlur = vi.spyOn(view, 'blur');
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready: vi.fn() });
    // Операция без ввода (снимок): только `end`.
    lender.restore();
    expect(document.activeElement).toBe(view);
    // Операция с вводом, а человек уже был в этой странице.
    lender.borrow('f-11');
    lender.restore();
    expect(document.activeElement).toBe(view);
    expect(viewBlur).not.toHaveBeenCalled();
  });

  it('цепочка двух лендеров (страховка к аренде клавиатуры main, финальная рецензия B1): фокус возвращается в Chat, а не в <webview> первого агента', () => {
    const chat = document.createElement('textarea');
    document.body.append(chat);
    chat.focus();
    const first = document.createElement('webview');
    first.tabIndex = 0;
    const second = document.createElement('webview');
    second.tabIndex = 0;
    document.body.append(first, second);
    const a = createFocusLender({ view: () => first, webContentsId: 7, ready: vi.fn() });
    const b = createFocusLender({ view: () => second, webContentsId: 8, ready: vi.fn() });
    a.borrow('f-12');
    b.borrow('f-13');
    expect(document.activeElement).toBe(second);
    a.restore();
    b.restore();
    expect(document.activeElement).toBe(chat);
    expect(isLendingFocus(7)).toBe(false);
    expect(isLendingFocus(8)).toBe(false);
  });

  it('dispose возвращает фокус и снимает флаг', () => {
    const chat = document.createElement('textarea');
    document.body.append(chat);
    chat.focus();
    const view = document.createElement('div');
    view.tabIndex = 0;
    document.body.append(view);
    const lender = createFocusLender({ view: () => view, webContentsId: 7, ready: vi.fn() });
    lender.borrow('f-5');
    lender.dispose();
    expect(document.activeElement).toBe(chat);
    expect(isLendingFocus(7)).toBe(false);
  });
});
