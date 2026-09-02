import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { Dialog, type DialogField } from './dialog.js';

pinUnicodeGlyphs();

const ESC = '\u001B';
const TAB = '\t';
const ENTER = '\r';
const RIGHT = '\u001B[C';
const LEFT = '\u001B[D';
const BACKSPACE = '\u007F';
const DOWN = '\u001B[B';

const waitFor = async (check: () => boolean, timeoutMs = 4000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * Ink подписывается на stdin эффектом, а обработчик клавиш пересоздаётся на
 * каждый рендер: между кадром и готовностью подписки есть зазор. Поэтому перед
 * каждым нажатием ждём — иначе клавиша достаётся обработчику прошлого рендера.
 */
const press = async (
  app: { stdin: { write: (data: string) => void; listenerCount: (event: string) => number } },
  key: string,
): Promise<void> => {
  await waitFor(() => app.stdin.listenerCount('readable') > 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
  app.stdin.write(key);
};

const FIELDS: DialogField[] = [
  { key: 'title', label: 'Заголовок' },
  { key: 'goal', label: 'Цель', optional: true, multiline: true },
];

const setup = (over: Partial<Parameters<typeof Dialog>[0]> = {}) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const app = render(
    <Dialog
      fields={FIELDS}
      footer="Enter — создать · Esc — отмена"
      width={40}
      height={10}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { app, onSubmit, onCancel };
};

describe('Dialog', () => {
  it('рисует поля и подсказку; заголовок берёт на себя панель', () => {
    const { app } = setup({ info: ['Проект: ~/dev/shop'] });
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Проект: ~/dev/shop');
    expect(frame).toContain('Заголовок');
    expect(frame).toContain('Цель');
    expect(frame).toContain('Enter — создать');
    app.unmount();
  });

  it('печатает в активное поле, Tab уводит в следующее', async () => {
    const { app, onSubmit } = setup();
    await press(app, 'Авторизация');
    await waitFor(() => (app.lastFrame() ?? '').includes('Авторизация'));
    await press(app, TAB);
    await press(app, 'логин');
    await waitFor(() => (app.lastFrame() ?? '').includes('логин'));

    await press(app, ENTER);
    await waitFor(() => onSubmit.mock.calls.length > 0);
    expect(onSubmit).toHaveBeenCalledWith({ title: 'Авторизация', goal: 'логин' });
    app.unmount();
  }, 15_000);

  it('Enter на непоследнем поле только переводит к следующему', async () => {
    const { app, onSubmit } = setup();
    await press(app, 'Авторизация');
    await waitFor(() => (app.lastFrame() ?? '').includes('Авторизация'));
    await press(app, ENTER);
    await press(app, 'цель');
    await waitFor(() => (app.lastFrame() ?? '').includes('цель'));
    expect(onSubmit).not.toHaveBeenCalled();
    app.unmount();
  }, 15_000);

  it('пустое обязательное поле не даёт подтвердить', async () => {
    const { app, onSubmit } = setup();
    await press(app, ENTER);
    await press(app, ENTER);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onSubmit).not.toHaveBeenCalled();
    app.unmount();
  }, 15_000);

  it('backspace стирает последний знак', async () => {
    const { app } = setup();
    await press(app, 'абв');
    await waitFor(() => (app.lastFrame() ?? '').includes('абв'));
    await press(app, BACKSPACE);
    await waitFor(() => !(app.lastFrame() ?? '').includes('абв'));
    expect(app.lastFrame()).toContain('аб');
    app.unmount();
  }, 15_000);

  it('Esc закрывает без изменений', async () => {
    const { app, onCancel, onSubmit } = setup();
    await press(app, ESC);
    await waitFor(() => onCancel.mock.calls.length > 0);
    expect(onSubmit).not.toHaveBeenCalled();
    app.unmount();
  }, 15_000);

  it('селектор ходит ‹ › по вариантам и перешагивает недоступные', async () => {
    const fields: DialogField[] = [
      {
        key: 'provider',
        label: 'Провайдер',
        options: [
          { id: 'claude', label: 'Claude' },
          { id: 'glm', label: 'GLM', disabled: true },
          { id: 'codex', label: 'Codex' },
        ],
      },
    ];
    const { app, onSubmit } = setup({ fields });
    expect(app.lastFrame()).toContain('‹ Claude ›');
    await press(app, RIGHT);
    await waitFor(() => (app.lastFrame() ?? '').includes('‹ Codex ›'));
    await press(app, LEFT);
    await waitFor(() => (app.lastFrame() ?? '').includes('‹ Claude ›'));

    await press(app, ENTER);
    await waitFor(() => onSubmit.mock.calls.length > 0);
    expect(onSubmit).toHaveBeenCalledWith({ provider: 'claude' });
    app.unmount();
  }, 15_000);

  it('без полей — только подтверждение, тело листается ↑↓', async () => {
    const quote = Array.from({ length: 12 }, (_, at) => `строка брифа ${at}`);
    const { app, onSubmit } = setup({
      fields: [],
      info: ['бриф: briefs/s-04.md'],
      quote,
      footer: 'Enter — запустить · Esc — позже',
      height: 6,
    });
    expect(app.lastFrame()).toContain('бриф: briefs/s-04.md');
    expect(app.lastFrame()).toContain('строка брифа 0');
    expect(app.lastFrame()).not.toContain('строка брифа 11');

    await press(app, DOWN);
    await press(app, DOWN);
    await waitFor(() => !(app.lastFrame() ?? '').includes('строка брифа 0'));

    await press(app, ENTER);
    await waitFor(() => onSubmit.mock.calls.length > 0);
    expect(onSubmit).toHaveBeenCalledWith({});
    app.unmount();
  }, 15_000);
});
