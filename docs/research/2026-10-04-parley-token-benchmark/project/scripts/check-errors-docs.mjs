// Принятие задачи errors-docs: node scripts/check-errors-docs.mjs
import { readFileSync } from 'node:fs';
import { parsePort } from '../src/net.js';

const problems = [];
for (const bad of ['0', '70000', 'abc']) {
  try {
    parsePort(bad);
    problems.push(`parsePort(${bad}) должен бросать ошибку`);
  } catch (error) {
    if (error?.code !== 'E-NET-001') problems.push(`код ошибки для ${bad}: ждали E-NET-001, получили ${error?.code}`);
  }
}
if (parsePort('8080') !== 8080) problems.push('parsePort("8080") должен вернуть 8080');
const source = readFileSync('src/net.js', 'utf8');
const docs = source.split('export function parsePort')[0]?.split('/**').pop() ?? '';
if (!/@since 1\.2\.0/.test(docs)) problems.push('в JSDoc нет "@since 1.2.0"');
if (!/@throws \{E-NET-001\} /.test(docs)) problems.push('в JSDoc нет "@throws {E-NET-001} ..."');
if (problems.length > 0) {
  console.error(`FAIL: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('OK');
