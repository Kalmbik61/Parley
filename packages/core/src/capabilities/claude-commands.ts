/**
 * Встроенные слеш-команды Claude Code 2.1.x для подсказок поля ввода вида «Chat» (живая проверка
 * 2026-10-02). Список статический: у CLI нет способа выдать его машинно. `terminal: true` — команда
 * открывает меню или диалог, живущий только в терминале; окно вставляет её текст, разбирает CLI сам.
 */
import type { CapabilityCommand } from './types.js';

const COMMANDS: readonly CapabilityCommand[] = [
  { name: 'add-dir', description: 'Add a working directory to the session', terminal: false },
  { name: 'agents', description: 'Manage subagents', terminal: true },
  { name: 'clear', description: 'Clear the conversation history', terminal: false },
  { name: 'compact', description: 'Compact the conversation, optionally with focus instructions', terminal: false },
  { name: 'config', description: 'Open the settings menu', terminal: true },
  { name: 'context', description: 'Show how the context window is used', terminal: false },
  { name: 'cost', description: 'Show token usage and cost of the session', terminal: false },
  { name: 'doctor', description: 'Check the health of the Claude Code installation', terminal: true },
  { name: 'effort', description: 'Set the reasoning effort level', terminal: false },
  { name: 'exit', description: 'Exit Claude Code', terminal: false },
  { name: 'export', description: 'Export the conversation to a file or the clipboard', terminal: false },
  { name: 'fast', description: 'Toggle fast mode', terminal: false },
  { name: 'help', description: 'Show help and available commands', terminal: false },
  { name: 'hooks', description: 'Manage hook configuration', terminal: true },
  { name: 'init', description: 'Create a CLAUDE.md for the project', terminal: false },
  { name: 'mcp', description: 'Manage MCP servers', terminal: true },
  { name: 'memory', description: 'Edit memory files', terminal: true },
  {
    name: 'model',
    description: 'Switch the model: pass a name as an argument (without one it opens a menu in the terminal)',
    terminal: false,
  },
  { name: 'permissions', description: 'Manage tool permission rules', terminal: true },
  { name: 'plan', description: 'Enter plan mode', terminal: false },
  { name: 'plugin', description: 'Manage plugins and marketplaces', terminal: true },
  { name: 'resume', description: 'Resume a previous conversation', terminal: true },
  { name: 'review', description: 'Review a pull request', terminal: false },
  { name: 'rewind', description: 'Rewind the conversation or code to an earlier point', terminal: true },
  { name: 'status', description: 'Show version, model, account and connectivity status', terminal: false },
  { name: 'usage', description: 'Show plan usage and rate limits', terminal: false },
];

export function claudeCommands(): readonly CapabilityCommand[] {
  return COMMANDS;
}
