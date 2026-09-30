import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { ACTIONS, type ActionDef, type ActionId, type MenuName } from '../shared/keybindings.js';
import { S } from '../shared/strings.js';

/**
 * Пункт реестра (кусок 6.1b, спека 9.6). Сочетание показывается, но сочетаниями владеет
 * обработчик рендерера (`renderer/keys/handler.ts`). `registerAccelerator: false` на macOS
 * не действует (`@platform linux,win32`): ⌘-сочетание сначала получает страница, а пункт —
 * только необработанное ею, то есть отданное полю или не узнанное. Такой клик приходит с
 * `triggeredByAccelerator` и ничего не шлёт: иначе ⌘K в сайдбаре чистил бы терминал в обход
 * правил фокуса. Мышью — `menu:action`, как раньше.
 */
function registryItem(action: ActionDef, send: (id: ActionId) => void): MenuItemConstructorOptions {
  return {
    label: action.title,
    ...(action.keys === null ? {} : { accelerator: action.keys }),
    registerAccelerator: false,
    click: (_item, _window, event) => {
      if (event.triggeredByAccelerator !== true) send(action.id);
    },
  };
}

function itemsOf(menu: MenuName, send: (id: ActionId) => void): MenuItemConstructorOptions[] {
  return ACTIONS.filter((action) => action.menu === menu).map((action) => registryItem(action, send));
}

/** Системное меню из реестра: порядок пунктов — порядок `ACTIONS`. */
export function buildMenuTemplate(send: (id: ActionId) => void): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Parley',
      // Подписи ролей about и quit заданы явно: свои Electron строит из `app.name`, а это `name` из package.json.
      submenu: [
        { role: 'about', label: 'About Parley' },
        { type: 'separator' },
        ...itemsOf('app', send),
        { type: 'separator' },
        { role: 'quit', label: 'Quit Parley' },
      ],
    },
    {
      label: S.menu.edit,
      // Родные роли — с зарегистрированными сочетаниями: работают в любом сфокусированном поле.
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        ...itemsOf('edit', send),
      ],
    },
    { label: S.menu.view, submenu: itemsOf('view', send) },
    { label: S.menu.workspace, submenu: itemsOf('workspace', send) },
    { label: S.menu.tab, submenu: itemsOf('tab', send) },
    { label: S.menu.terminal, submenu: itemsOf('terminal', send) },
  ];
}

export function createAppMenu(getFocusedWindow: () => BrowserWindow | null): Menu {
  const send = (id: ActionId): void => {
    getFocusedWindow()?.webContents.send('menu:action', id);
  };
  const menu = Menu.buildFromTemplate(buildMenuTemplate(send));
  Menu.setApplicationMenu(menu);
  return menu;
}
