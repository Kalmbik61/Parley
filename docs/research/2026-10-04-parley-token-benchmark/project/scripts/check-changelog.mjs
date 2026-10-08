// Принятие задачи changelog: node scripts/check-changelog.mjs <номер задачи>
import { readFileSync } from 'node:fs';

const issue = process.argv[2] ?? '4711';
const text = readFileSync('CHANGELOG.md', 'utf8');
const unreleased = text.split('## [Unreleased]')[1]?.split('\n## [')[0] ?? '';
const entry = unreleased.split('\n').find((line) => line.startsWith('- '));
const ok = entry !== undefined && new RegExp(`^- \\[(added|fixed|changed)\\] [^.]+[^.] \\(#${issue}\\)$`).test(entry);
if (!ok) {
  console.error(`FAIL: в [Unreleased] нет строки формата "- [added|fixed|changed] текст (#${issue})"`);
  process.exit(1);
}
console.log('OK');
