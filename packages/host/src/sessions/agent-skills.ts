/**
 * Скилл `parley` при запуске сессии (кусок 10 плана комнат): хост зовёт установку из core перед
 * каждым запуском, включая `resume` и фоновый autoLaunch, — установка идемпотентна и быстра, а
 * устаревший свой скилл она заодно обновляет и убирает свою прежнюю установку под именем `harnas`.
 *
 * Скилл — удобство, а не условие работы агента: сбой установки запуск сессии не останавливает, он
 * пишется в `host.log`. Настройка `agentSkills` выключена — не делается ничего, ни установки, ни
 * обновления; уже поставленное остаётся. Путь, который харнесс не тронул, попадает в `host.log`, а
 * чужой — ещё и в `host.notice` окна: человеку видно, почему в его проекте скилла нет.
 */

import path from 'node:path';
import {
  installAgentSkill,
  LEGACY_SKILL_NAME,
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

/** Что сказать про каждый вид «не тронуто»: этот же английский текст — в лог и в уведомление окна. */
const LOG_TEXT: Record<SkillSkip['reason'], string> = {
  foreign: 'Parley skill was not installed: the path already exists and was not created by Parley — left as is',
  edited: 'Parley skill was not updated: the file was edited by hand — left as is',
  unsafe: 'Parley skill was not installed: a symlink or a file stands in place of a directory on the way to the path',
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
        host.log.info('скилл parley установлен или обновлён', { ref, paths: result.written });
      }
      if (result.removed.length > 0) {
        host.log.info(`прежний скилл ${LEGACY_SKILL_NAME} убран`, { ref, paths: result.removed });
      }
      for (const skip of result.skipped) report(ref, skip);
    } catch (error) {
      host.log.error('скилл parley не поставлен: сбой записи, сессия запускается без него', {
        ref,
        skill: SKILL_NAME,
        error: String(error),
      });
    }
  };
}
