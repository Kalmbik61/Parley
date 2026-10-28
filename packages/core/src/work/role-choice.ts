/**
 * Провайдер и модель роли: одно правило для окна и для помощника на хосте. Модуль чистый — ни Node-импортов, ни
 * значений из других файлов core (тип `RoleSummary` стирается при сборке), поэтому его берёт и окно через подпуть
 * `@parley/core/role-choice`, как `@parley/core/session-state`. Основной вход core окно не берёт: он тянет Node.
 */

import type { RoleSummary } from './agents.js';

/**
 * Провайдер строки агента. Роль из Claude Code или Codex навязывает свой провайдер; у встроенной роли выбранный
 * провайдер главнее своего, а своего нет — берётся умолчание.
 */
export function roleProvider(role: Pick<RoleSummary, 'source' | 'provider'> | undefined, chosen: string | null, fallback: string | null): string | null {
  return role !== undefined && role.source !== 'builtin' ? role.provider : chosen ?? role?.provider ?? fallback;
}

/**
 * Модель роли на провайдере. У встроенной роли своя модель на каждого из двух рантаймов (все провайдеры, кроме Codex,
 * идут по рантайму Claude Code); у остальных — модель из самой роли.
 */
export function roleModel(role: Pick<RoleSummary, 'source' | 'model' | 'models'> | undefined, provider: string | null): string | null {
  if (role === undefined) return null;
  if (role.source === 'builtin') return (provider === 'codex' ? role.models?.codex : role.models?.claude) ?? null;
  return role.model ?? null;
}
