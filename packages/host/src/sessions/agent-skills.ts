/**
 * Скилл `harnas` при запуске сессии (кусок 10 плана комнат): хост зовёт установку из core перед
 * каждым запуском, включая `resume` и фоновый autoLaunch, — установка идемпотентна и быстра, а
 * устаревший свой скилл она заодно обновляет.
 *
 * Скилл — удобство, а не условие работы агента: сбой установки запуск сессии не останавливает, он
 * пишется в `host.log`. Настройка `agentSkills` выключена — не делается ничего, ни установки, ни
 * обновления; уже поставленное остаётся. Путь, который харнесс не тронул, попадает в `host.log`, а
 * чужой — ещё и в `host.notice` окна: человеку видно, почему в его проекте скилла нет.
 */

import path from 'node:path';
import {
  installAgentSkill,
  loadConfig,
  SKILL_NAME,
  type SkillInstallOptions,
  type SkillInstallResult,
  type SkillSkip,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';

/** Установщик для сессии: `worktreePath` — её worktree, если он есть и уже заведён на диске. */
export type SkillInstaller = (ref: SessionRef, worktreePath: string | null) => Promise<void>;

type Install = (options: SkillInstallOptions) => Promise<SkillInstallResult>;

/** Что сказать в лог про каждый вид «не тронуто»; текст хоста — по-русски, как остальные его записи. */
const LOG_TEXT: Record<SkillSkip['reason'], string> = {
  foreign: 'скилл harnas не поставлен: путь уже есть, а создан не харнессом — оставлен как есть',
  edited: 'скилл harnas не обновлён: файл правили вручную — оставлен как есть',
  unsafe: 'скилл harnas не поставлен: по дороге к пути симлинк или файл вместо каталога',
};

export function createSkillInstaller(
  host: HostContext,
  install: Install = installAgentSkill,
): SkillInstaller {
  // Каждый путь и причину сообщаем один раз за жизнь хоста: запуск сессии — частое событие, а чужой
  // скилл в проекте не изменится от того, что о нём скажут ещё раз.
  const reported = new Set<string>();

  function report(ref: SessionRef, skip: SkillSkip): void {
    const key = `${skip.path}\u0000${skip.reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    host.log.warn(LOG_TEXT[skip.reason], { path: skip.path, reason: skip.reason });

    // Окну — только про папку самого проекта и только про то, что не наше: правку человека он сделал
    // сам, а в worktree копия чужого скилла из репозитория — то же, что уже сказано про проект.
    const inProject = skip.path.startsWith(`${ref.projectPath}${path.sep}`);
    if (skip.reason === 'edited' || !inProject) return;
    host.broadcast('host.notice', {
      kind: 'skill-foreign',
      ref: null,
      text: `${LOG_TEXT[skip.reason]}: ${skip.path}`,
      at: new Date().toISOString(),
    });
  }

  return async (ref, worktreePath) => {
    try {
      const { config } = await loadConfig();
      if (!config.agentSkills) return;
      const result = await install({
        projectPath: ref.projectPath,
        ...(worktreePath === null ? {} : { worktreePath }),
      });
      if (result.written.length > 0) {
        host.log.info('скилл harnas установлен или обновлён', { ref, paths: result.written });
      }
      for (const skip of result.skipped) report(ref, skip);
    } catch (error) {
      host.log.error('скилл harnas не поставлен: сбой записи, сессия запускается без него', {
        ref,
        skill: SKILL_NAME,
        error: String(error),
      });
    }
  };
}
