import { defineCatalog } from './index.js';

export const roleChangeCatalog = defineCatalog(
  {
    withoutRole: 'without a role',
    withRole: 'as {name} ({source})',
    readOnly: 'is a read-only role',
    unverified: 'may be a read-only role (its Codex settings could not be verified)',
    readOnlyLost: '{name} {kind} and does not run on {target}. The session will continue {after}, and can edit files and run commands.',
    changed: 'Role {name} does not run on {target}. The session will continue {after}.',
  },
  {
    withoutRole: 'без роли',
    withRole: 'с ролью {name} ({source})',
    readOnly: 'Роль только для чтения',
    unverified: 'Возможно, это роль только для чтения. Настройки Codex проверить не удалось',
    readOnlyLost: '{kind}: {name}. Провайдер {target} её не поддерживает. Сессия продолжится {after}, с возможностью редактировать файлы и запускать команды.',
    changed: 'Провайдер {target} не поддерживает роль {name}. Сессия продолжится {after}.',
  },
);
