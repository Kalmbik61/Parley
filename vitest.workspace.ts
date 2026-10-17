import { defineWorkspace } from 'vitest/config';

// Корневой `npx vitest run` без этого файла шёл мимо конфигов пакетов: не применялся `setupFiles` песочницы дома
// (`test/sandbox-home.ts`) у core и host, и тесты писали в настоящий `~/.parley` (инцидент 17.10.2026).
// Каждый пакет подхватывает свой `vitest.config.ts`; у protocol и file-icons конфига нет — берутся умолчания.
export default defineWorkspace([
  'packages/core',
  'packages/host',
  'packages/desktop',
  'packages/protocol',
  'packages/file-icons',
]);
