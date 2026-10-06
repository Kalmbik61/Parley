/**
 * Тест 1 куска 6.1b (спека 9.6): системное меню строится из реестра клавиш. Пункт реестра
 * показывает сочетание, но клик с `triggeredByAccelerator` не шлёт `menu:action` — сочетаниями
 * владеет обработчик рендерера, и необработанное им (поле, сайдбар) в обход правил фокуса не
 * выполняется.
 */
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron';
import type { ActionId } from '../shared/keybindings.js';

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() } }));

const { buildMenuTemplate } = await import('./menu.js');

function submenuOf(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(item.submenu) ? (item.submenu as MenuItemConstructorOptions[]) : [];
}

function allItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap(submenuOf);
}

function click(item: MenuItemConstructorOptions | undefined, event: KeyboardEvent): void {
  item?.click?.({} as MenuItem, undefined, event);
}

describe('buildMenuTemplate (тест 1)', () => {
  it('подписи меню — Parley, Edit, View, Workspace, Tab, Terminal; кириллицы нет', () => {
    const template = buildMenuTemplate(() => {});
    expect(template.map((item) => item.label)).toEqual(['Parley', 'Edit', 'View', 'Workspace', 'Tab', 'Terminal']);
    const labels = [...template, ...allItems(template)].map((item) => item.label ?? '');
    expect(labels.filter((label) => /[Ѐ-ӿ]/.test(label))).toEqual([]);
  });

  it('Edit — родные роли undo, redo, cut, copy, paste, selectAll и пункты Find, Toggle dictation', () => {
    const edit = buildMenuTemplate(() => {}).find((item) => item.label === 'Edit');
    const items = edit === undefined ? [] : submenuOf(edit).filter((item) => item.type !== 'separator');
    expect(items.filter((item) => item.role !== undefined).map((item) => item.role)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll',
    ]);
    expect(items.filter((item) => item.role === undefined).map((item) => item.label)).toEqual(['Find', 'Toggle dictation']);
  });

  it('Parley — about, Settings, quit; у about и quit явные подписи с именем продукта', () => {
    const app = buildMenuTemplate(() => {}).find((item) => item.label === 'Parley');
    const items = app === undefined ? [] : submenuOf(app).filter((item) => item.type !== 'separator');
    expect(items.map((item) => item.role ?? item.label)).toEqual(['about', 'Settings', 'quit']);
    expect(items.filter((item) => item.role !== undefined).map((item) => item.label)).toEqual(['About Parley', 'Quit Parley']);
  });

  it('клик по Command palette с triggeredByAccelerator не шлёт, мышью — шлёт palette.open', () => {
    const sent: ActionId[] = [];
    const palette = allItems(buildMenuTemplate((id) => sent.push(id))).find((item) => item.label === 'Command palette');
    expect(palette?.accelerator).toBe('CmdOrCtrl+J');
    expect(palette?.registerAccelerator).toBe(false);
    click(palette, { triggeredByAccelerator: true });
    expect(sent).toEqual([]);
    click(palette, {});
    click(palette, { triggeredByAccelerator: false });
    expect(sent).toEqual(['palette.open', 'palette.open']);
  });

  it('Clear terminal ⌘K в меню Terminal: сочетанием не шлёт, мышью шлёт terminal.clear', () => {
    const sent: ActionId[] = [];
    const terminal = buildMenuTemplate((id) => sent.push(id)).find((item) => item.label === 'Terminal');
    const clear = terminal === undefined ? undefined : submenuOf(terminal).find((item) => item.label === 'Clear terminal');
    expect(clear?.accelerator).toBe('CmdOrCtrl+K');
    click(clear, { triggeredByAccelerator: true });
    click(clear, {});
    expect(sent).toEqual(['terminal.clear']);
  });

  it('у browser.*, tab.goto.N и tab.mru* пунктов нет, у files.quickOpen — есть', () => {
    const labels = allItems(buildMenuTemplate(() => {})).map((item) => item.label);
    for (const absent of ['Tab 1', 'Tab 9', 'Next recent tab', 'Previous recent tab', 'Find in page', 'Zoom in', 'Zoom out', 'Actual size']) {
      expect(labels).not.toContain(absent);
    }
    expect(labels).toContain('Go to file');
    expect(labels).toContain('Workspace 1');
    expect(labels).toContain('Workspace 9');
  });
});
