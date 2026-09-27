import { defineConfig } from '@playwright/test';

// Уведомления окна в E2E — в журнал main, а не на экран человека (кусок 4.3): спеки передают
// окну `...process.env`, а конфиг исполняется и в каждом воркере Playwright.
process.env.HARNAS_NOTIFICATIONS = 'log';
// «Открыть в приложении» и «Показать в Finder» — тоже в журнал main (кусок 5.2): настоящие
// shell.openPath и shell.showItemInFolder открыли бы приложение и Finder на экране человека.
process.env.HARNAS_SHELL = 'log';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
});
