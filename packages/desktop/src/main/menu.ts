import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../shared/bridge.js';

const WORK_ACCELERATORS: ReadonlyArray<readonly [MenuAction, string]> = [
  ['work-1', 'CmdOrCtrl+1'],
  ['work-2', 'CmdOrCtrl+2'],
  ['work-3', 'CmdOrCtrl+3'],
  ['work-4', 'CmdOrCtrl+4'],
  ['work-5', 'CmdOrCtrl+5'],
  ['work-6', 'CmdOrCtrl+6'],
  ['work-7', 'CmdOrCtrl+7'],
  ['work-8', 'CmdOrCtrl+8'],
  ['work-9', 'CmdOrCtrl+9'],
];

/**
 * Системное меню — единственный способ дотянуться до рендерера с клавиатуры
 * вне фокуса терминала (тот сам ловит нажатия). Действия этапа 2 (⌘D, ⇧⌘D,
 * ⌘[, ⌘], ⌘K) уже висят на пунктах меню, но в этапе 1 рендерер их не слушает.
 */
export function createAppMenu(getFocusedWindow: () => BrowserWindow | null): Menu {
  const send = (action: MenuAction): void => {
    getFocusedWindow()?.webContents.send('menu:action', action);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Harnas',
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'Правка',
      submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'Сессия',
      submenu: [
        { label: 'Новая сессия', accelerator: 'CmdOrCtrl+T', click: () => send('new-session') },
        { label: 'Новая работа', accelerator: 'CmdOrCtrl+N', click: () => send('new-work') },
        { label: 'Закрыть панель', accelerator: 'CmdOrCtrl+W', click: () => send('close-panel') },
        { label: 'Разделить справа', accelerator: 'CmdOrCtrl+D', click: () => send('split-right') },
        { label: 'Разделить снизу', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('split-down') },
        { type: 'separator' },
        { label: 'Предыдущая панель', accelerator: 'CmdOrCtrl+[', click: () => send('prev-panel') },
        { label: 'Следующая панель', accelerator: 'CmdOrCtrl+]', click: () => send('next-panel') },
        { type: 'separator' },
        { label: 'Палитра команд', accelerator: 'CmdOrCtrl+K', click: () => send('palette') },
        { label: 'Найти', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: 'Настройки', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        ...WORK_ACCELERATORS.map(
          ([action, accelerator]): MenuItemConstructorOptions => ({
            label: `Работа ${action.slice(-1)}`,
            accelerator,
            click: () => send(action),
          }),
        ),
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Сайдбар работ', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-left-sidebar') },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
