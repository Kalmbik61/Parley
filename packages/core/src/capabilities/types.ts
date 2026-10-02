/**
 * Возможности CLI провайдера, которые окно подсказывает в поле ввода вида «Chat» (живая проверка
 * 2026-10-02, просьба пользователя: выбирать скиллы, модели и `@` из списка). Parley ничего своего не
 * заводит и ничего не пишет: скиллы, команды и субагенты — те, что уже лежат у человека и в проекте
 * для самого CLI (дизайн `docs/specs/2026-10-02-capabilities-design.md`, раздел 1); окно лишь
 * показывает список и вставляет текст, который CLI разбирает сам.
 */

/** Встроенная слеш-команда CLI. `terminal: true` — открывает меню или диалог, живущий только в терминале. */
export interface CapabilityCommand {
  /** Без ведущей `/`: `clear`, `model`, `compact`. */
  name: string;
  description: string;
  terminal: boolean;
}

/** Откуда взят скилл или субагент: папка человека, проект (вместе с рабочей копией сессии) или плагин. */
export type CapabilitySource = 'user' | 'project' | 'plugin';

/** Скилл или своя команда: в поле ввода — `/name`; у скилла плагина `name` вида `plugin:skill`. */
export interface CapabilitySkill {
  name: string;
  /** `description` из frontmatter `SKILL.md` или файла команды; `null` — не указано. */
  description: string | null;
  source: CapabilitySource;
  /** Папка скилла или файл команды — для подсказки человеку, окно его не читает. */
  path: string;
}

/** Субагент Claude Code (`agents/*.md`): в промпте — `@name`. */
export interface CapabilityAgent {
  name: string;
  description: string | null;
  source: CapabilitySource;
  path: string;
}

export interface Capabilities {
  commands: CapabilityCommand[];
  skills: CapabilitySkill[];
  agents: CapabilityAgent[];
}
