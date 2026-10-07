// Принятие задачи release-notes: node scripts/check-release-notes.mjs
import { readFileSync } from 'node:fs';

const text = readFileSync('docs/RELEASE-1.3.0.md', 'utf8');
const headings = text.split('\n').filter((line) => line.startsWith('#'));
const order = ['# Release 1.3.0', '## Highlights', '## Upgrade', '## Contact'];
const problems = [];
if (headings.join('|') !== order.join('|')) problems.push(`заголовки должны идти так: ${order.join(', ')}`);
if (!/^Run: .+/m.test(text)) problems.push('в Upgrade нужна строка "Run: ..."');
if (!text.includes('Questions: team@bench.invalid')) problems.push('нужна строка контакта');
const highlights = text.split('## Highlights')[1]?.split('\n## ')[0] ?? '';
if (highlights.split('\n').filter((line) => line.startsWith('- ')).length > 3) problems.push('в Highlights не больше трёх пунктов');
if (problems.length > 0) {
  console.error(`FAIL: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('OK');
