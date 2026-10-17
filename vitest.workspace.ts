import { defineWorkspace } from 'vitest/config';

// Корневой `npx vitest run` без этого файла шёл мимо конфигов пакетов: не применялся `setupFiles` песочницы дома
// (`test/sandbox-home.ts`) у core и host, и тесты писали в настоящий `~/.parley` (инцидент 17.10.2026).
// Каждый пакет подхватывает свой `vitest.config.ts`; у protocol и file-icons конфига нет — берутся умолчания.
// `packages/*` — чтобы новый пакет не выпал из корневого прогона молча; `tools` — тесты стенда токен-бенчмарка.
//
// Ловушка: НЕ добавлять корневой `vitest.config.ts`. protocol и file-icons без своего конфига ищут его вверх по
// дереву (`findUp`) и нашли бы корневой вместе с этим файлом — тогда `pnpm -r test` в каждом из них гонял бы
// ВСЕ пакеты. Понадобится корневой конфиг — сначала дайте этим двум пакетам минимальный свой `vitest.config.ts`.
export default defineWorkspace(['packages/*', 'tools']);
