/**
 * Тест 4 куска 3.6 плана окна: «Закрыть…» без подтверждения ничего не шлёт.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionMenu } from './SessionMenu.js';

afterEach(cleanup);

function renderMenu(onClose: () => void): void {
  render(
    <SessionMenu
      status="active"
      closed={false}
      label="S01 план"
      onOpen={() => {}}
      onResume={() => {}}
      onStop={() => {}}
      onClose={onClose}
      onDelete={() => {}}
      onCreateRoom={() => {}}
    >
      <div>строка сессии</div>
    </SessionMenu>,
  );
}

describe('SessionMenu — тест 4', () => {
  it('«Закрыть…» открывает подтверждение, но само по себе ничего не шлёт', () => {
    let closed = false;
    renderMenu(() => (closed = true));

    fireEvent.contextMenu(screen.getByText('строка сессии'));
    fireEvent.click(screen.getByText('Закрыть…'));

    expect(screen.getByText('Закрыть «S01 план»?')).toBeTruthy();
    expect(screen.getByText('Сессия больше не получит писем')).toBeTruthy();
    expect(closed).toBe(false);
  });

  it('подтверждение шлёт onClose', () => {
    let closed = false;
    renderMenu(() => (closed = true));

    fireEvent.contextMenu(screen.getByText('строка сессии'));
    fireEvent.click(screen.getByText('Закрыть…'));
    fireEvent.click(screen.getByText('Закрыть'));

    expect(closed).toBe(true);
  });

  it('отмена в диалоге тоже ничего не шлёт', () => {
    let closed = false;
    renderMenu(() => (closed = true));

    fireEvent.contextMenu(screen.getByText('строка сессии'));
    fireEvent.click(screen.getByText('Закрыть…'));
    fireEvent.click(screen.getByText('Отмена'));

    expect(closed).toBe(false);
  });

  it('уже закрытую сессию пункт «Закрыть…» не предлагает', () => {
    render(
      <SessionMenu
        status="exited"
        closed
        label="S01 план"
        onOpen={() => {}}
        onResume={() => {}}
        onStop={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onCreateRoom={() => {}}
      >
        <div>строка сессии</div>
      </SessionMenu>,
    );

    fireEvent.contextMenu(screen.getByText('строка сессии'));
    expect(screen.queryByText('Закрыть…')).toBeNull();
  });
});
