// Принятие задачи long-rule: node scripts/check-long-rule.mjs
import { makeInvoice } from '../src/records.js';

const record = makeInvoice(120);
const ok = /^bnch_inv_\d+$/.test(String(record?.id)) && record?.total === 120;
if (!ok) {
  console.error(`FAIL: makeInvoice(120) вернул ${JSON.stringify(record)}; ждали id вида bnch_inv_<число> и total 120`);
  process.exit(1);
}
console.log('OK');
