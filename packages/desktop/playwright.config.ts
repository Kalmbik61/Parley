import { defineConfig } from '@playwright/test';

// Уведомления окна в E2E — в журнал main, а не на экран человека (кусок 4.3): спеки передают
// окну `...process.env`, а конфиг исполняется и в каждом воркере Playwright.
process.env.HARNAS_NOTIFICATIONS = 'log';
// «Открыть в приложении» и «Показать в Finder» — тоже в журнал main (кусок 5.2): настоящие
// shell.openPath и shell.showItemInFolder открыли бы приложение и Finder на экране человека.
process.env.HARNAS_SHELL = 'log';
// Скриншот из буфера — фиксированная картинка main (кусок 5.4): E2E не читают и не пишут
// настоящий буфер обмена человека.
process.env.HARNAS_DROPS = 'fake';
// Загрузки встроенного браузера — без настоящего диалога сохранения и мимо Downloads человека (ревью 9.1).
process.env.HARNAS_DOWNLOADS = 'log';
// Нативный вопрос «страница зависла» (fix-7.3 п. 5) — в журнал main, без системного диалога.
process.env.HARNAS_DIALOGS = 'log';
// Оболочку человека (`$SHELL -ilc` и её rc-файлы) окно в E2E не зовёт: PATH — тот, с которым запущен
// тест (кусок 11b, ревью). Разбор вывода настоящей оболочки держат юнит-тесты `shell-env.test.ts`.
process.env.HARNAS_LOGIN_SHELL = 'skip';

export default defineConfig({
  testDir: './e2e',
  // Список домов прогона и уборка хостов по нему в конце (e2e/global-setup.ts).
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
});
