#!/usr/bin/env node
// claude-export.mjs — экспорт сессий Claude Code в JSON.
// Зависимостей нет. Читает только ~/.claude/projects, ничего не пишет в ~/.claude.
//
//   node claude-export.mjs                     # индекс сессий -> ./claude-export
//   node claude-export.mjs --full              # + нормализованное дерево каждой сессии
//   node claude-export.mjs --limit 10 --full   # только 10 последних сессий
//   node claude-export.mjs --root /path --out /path

import { createReadStream } from 'node:fs';
import { readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------- аргументы ----------
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : (argv[i + 1] ?? true);
};
const ROOT = path.resolve(String(flag('--root', path.join(homedir(), '.claude', 'projects'))));
const OUT = path.resolve(String(flag('--out', './claude-export')));
const FULL = argv.includes('--full');
const LIMIT = Number(flag('--limit', 0)) || 0;

// ---------- обход ----------
async function findJsonl(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Не читается ${dir}: ${e.message}`);
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findJsonl(p)));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ---------- разбор одного файла ----------
// Формат недокументирован, поэтому ничего не считаем обязательным:
// всё достаём мягко, а незнакомое просто фиксируем в отчёте по схеме.
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return null;
};

async function parseFile(file, schema) {
  const records = [];
  const bad = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      bad.push(lineNo); // оборванная последняя строка живой сессии — норма
      continue;
    }
    observe(schema, rec);
    records.push(rec);
  }

  const meta = {
    sessionId: null, cwd: null, gitBranch: null, version: null,
    summary: null, startedAt: null, endedAt: null,
  };
  const models = new Map();
  const tools = new Map();
  const roles = new Map();
  const types = new Map();
  let sidechains = 0;

  for (const rec of records) {
    const type = pick(rec, 'type') ?? 'unknown';
    types.set(type, (types.get(type) ?? 0) + 1);

    meta.sessionId ??= pick(rec, 'sessionId', 'session_id');
    meta.cwd ??= pick(rec, 'cwd');
    meta.gitBranch ??= pick(rec, 'gitBranch', 'git_branch');
    meta.version ??= pick(rec, 'version');

    // Заголовок сессии: запись type:"summary". Иногда лежит в соседнем
    // файле и ссылается на leafUuid — тогда сшиваем глобально, ниже.
    if (type === 'summary') meta.summary ??= pick(rec, 'summary', 'title', 'text');

    const ts = pick(rec, 'timestamp', 'time', 'createdAt');
    if (ts) {
      if (!meta.startedAt || ts < meta.startedAt) meta.startedAt = ts;
      if (!meta.endedAt || ts > meta.endedAt) meta.endedAt = ts;
    }

    if (rec.isSidechain === true) sidechains++;

    const msg = rec.message;
    if (msg && typeof msg === 'object') {
      const role = pick(msg, 'role');
      if (role) roles.set(role, (roles.get(role) ?? 0) + 1);
      const model = pick(msg, 'model');
      if (model) models.set(model, (models.get(model) ?? 0) + 1);
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block && block.type === 'tool_use' && block.name) {
          tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
        }
      }
    }
  }

  const durationMs =
    meta.startedAt && meta.endedAt
      ? Math.max(0, Date.parse(meta.endedAt) - Date.parse(meta.startedAt))
      : null;

  const sortedCount = (m) =>
    Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));

  return {
    session: {
      ...meta,
      sessionId: meta.sessionId ?? path.basename(file, '.jsonl'),
      file,
      project: path.basename(path.dirname(file)),
      durationMs,
      durationHuman: durationMs == null ? null : human(durationMs),
      records: records.length,
      sidechains,
      malformedLines: bad.length,
      models: sortedCount(models),
      tools: sortedCount(tools),
      roles: sortedCount(roles),
      recordTypes: sortedCount(types),
      // «Какая модель тут работала» для бейджа в UI — самая частая
      primaryModel: [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    },
    records,
  };
}

function human(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}ч ${m}м` : m ? `${m}м` : `${s}с`;
}

// ---------- отчёт по схеме ----------
// Считает, какие поля реально встречаются у каждого типа записи.
// Это то, по чему сверяешь парсер, когда Anthropic поменяет формат.
function observe(schema, rec, prefix = '', type = null) {
  const t = type ?? (rec && rec.type) ?? 'unknown';
  if (!schema[t]) schema[t] = { count: 0, fields: {} };
  if (!prefix) schema[t].count++;
  for (const [k, v] of Object.entries(rec ?? {})) {
    const key = prefix + k;
    const kind = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const f = (schema[t].fields[key] ??= { seen: 0, kinds: {}, sample: null });
    f.seen++;
    f.kinds[kind] = (f.kinds[kind] ?? 0) + 1;
    if (f.sample === null && (kind === 'string' || kind === 'number' || kind === 'boolean')) {
      f.sample = kind === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
    }
    if (kind === 'object' && prefix.split('.').length < 3) observe(schema, v, key + '.', t);
  }
}

// ---------- дерево подсессий ----------
// Сайдчейны (isSidechain) — это вызовы субагентов. Каждый такой блок
// становится «подсессией» с собственным бейджем модели.
function buildTree(records) {
  const byUuid = new Map();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);

  const main = [];
  const groups = new Map();

  for (const r of records) {
    if (r.isSidechain !== true) {
      main.push(r);
      continue;
    }
    // поднимаемся по parentUuid до первого несайдчейнового предка
    let anchor = r, guard = 0;
    while (anchor && anchor.isSidechain === true && guard++ < 10000) {
      const parent = anchor.parentUuid ? byUuid.get(anchor.parentUuid) : null;
      if (!parent) break;
      anchor = parent;
    }
    const key = anchor?.uuid ?? 'orphan';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const subsessions = [...groups.entries()].map(([anchorUuid, recs]) => {
    const models = new Set();
    for (const r of recs) if (r.message?.model) models.add(r.message.model);
    const times = recs.map((r) => r.timestamp).filter(Boolean).sort();
    return {
      anchorUuid,
      records: recs.length,
      models: [...models],
      startedAt: times[0] ?? null,
      endedAt: times.at(-1) ?? null,
      // первая пользовательская реплика субагента = его «задача»
      task: firstText(recs),
    };
  });

  return { mainChain: main.length, subsessions };
}

function firstText(recs) {
  for (const r of recs) {
    const c = r.message?.content;
    if (typeof c === 'string') return c.slice(0, 200);
    if (Array.isArray(c)) {
      const t = c.find((b) => b?.type === 'text' && b.text);
      if (t) return String(t.text).slice(0, 200);
    }
  }
  return null;
}

// ---------- main ----------
const t0 = Date.now();
console.log(`Читаю ${ROOT}`);
const files = await findJsonl(ROOT);
if (!files.length) {
  console.error('Файлов .jsonl не найдено. Проверь путь через --root.');
  process.exit(1);
}

// сортируем по времени изменения, свежие первыми
const withTime = await Promise.all(
  files.map(async (f) => ({ f, mtime: (await stat(f)).mtimeMs })),
);
withTime.sort((a, b) => b.mtime - a.mtime);
const targets = (LIMIT ? withTime.slice(0, LIMIT) : withTime).map((x) => x.f);

console.log(`Найдено файлов: ${files.length}, обрабатываю: ${targets.length}`);
await mkdir(OUT, { recursive: true });
if (FULL) await mkdir(path.join(OUT, 'sessions'), { recursive: true });

const schema = {};
const index = [];
const summariesByLeaf = new Map();
let done = 0;

for (const file of targets) {
  try {
    const { session, records } = await parseFile(file, schema);

    // собираем summary-записи, которые ссылаются на чужие сессии
    for (const r of records) {
      if (r.type === 'summary' && r.leafUuid && (r.summary || r.title)) {
        summariesByLeaf.set(r.leafUuid, r.summary ?? r.title);
      }
    }
    session.leafUuids = records.filter((r) => r.uuid).map((r) => r.uuid);

    const tree = buildTree(records);
    session.subsessionCount = tree.subsessions.length;
    index.push(session);

    if (FULL) {
      await writeFile(
        path.join(OUT, 'sessions', `${session.sessionId}.json`),
        JSON.stringify({ session, tree, records }, null, 2),
      );
    }
  } catch (e) {
    console.warn(`  пропускаю ${path.basename(file)}: ${e.message}`);
  }
  if (++done % 25 === 0) console.log(`  ...${done}/${targets.length}`);
}

// досшиваем заголовки сессий по leafUuid
for (const s of index) {
  if (!s.summary) {
    for (const u of s.leafUuids) {
      if (summariesByLeaf.has(u)) { s.summary = summariesByLeaf.get(u); break; }
    }
  }
  delete s.leafUuids; // в индексе не нужны, файл раздувают
}

index.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));

await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
await writeFile(path.join(OUT, 'schema-report.json'), JSON.stringify(schema, null, 2));

const allModels = new Set();
for (const s of index) for (const m of Object.keys(s.models)) allModels.add(m);

console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
console.log(`  сессий:        ${index.length}`);
console.log(`  с summary:     ${index.filter((s) => s.summary).length}`);
console.log(`  с подсессиями: ${index.filter((s) => s.subsessionCount > 0).length}`);
console.log(`  модели:        ${[...allModels].join(', ') || '—'}`);
console.log(`  типы записей:  ${Object.keys(schema).join(', ')}`);
console.log(`\n  ${path.join(OUT, 'index.json')}`);
console.log(`  ${path.join(OUT, 'schema-report.json')}${FULL ? `\n  ${path.join(OUT, 'sessions')}/` : ''}`);
