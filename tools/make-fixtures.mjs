#!/usr/bin/env node
// make-fixtures.mjs — делает анонимные фикстуры из реальных сессий ~/.claude/projects.
//
// Работает по белому списку: структура записи (какие поля, какой вложенности, каких
// типов) сохраняется полностью, а КАЖДАЯ строка, не входящая в список структурных,
// заменяется на заглушку. Так фикстура остаётся честным слепком схемы и при этом
// заведомо не содержит ни путей, ни текстов, ни идентификаторов пользователя.
//
//   node tools/make-fixtures.mjs <session-id> [<session-id>...]
//
// Пишет в packages/core/test/fixtures/projects/ с сохранением раскладки каталогов.

import { createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = path.join(homedir(), '.claude', 'projects');
const OUT = path.resolve('packages/core/test/fixtures/projects');
const WANTED = process.argv.slice(2);

if (WANTED.length === 0) {
  console.error('Укажи id сессий: node tools/make-fixtures.mjs <session-id> [...]');
  process.exit(1);
}

// Строковые значения этих полей — перечисления и структурные признаки, не содержимое.
const KEEP_STRINGS = new Set([
  'type',
  'role',
  'model',
  'stop_reason',
  'stop_sequence',
  'service_tier',
  'speed',
  'inference_geo',
  'userType',
  'entrypoint',
  'version',
  'permissionMode',
  'promptSource',
  'subtype',
  'level',
  'source',
  'direction',
  'scope',
  'trigger',
  'name',
  'status',
  'mode',
  'effort',
  'agentType',
  'attributionAgent',
  'attributionSkill',
  'attributionPlugin',
  'attributionMcpServer',
  'attributionMcpTool',
]);

const FIXED = { cwd: '/Users/dev/project', gitBranch: 'main' };

// Идентификаторы перенумеровываются: связи внутри фикстуры сохраняются,
// связь с настоящими сессиями теряется.
const ids = new Map();
const fakeId = (real, prefix) => {
  if (!ids.has(real)) ids.set(real, `${prefix}${String(ids.size + 1).padStart(6, '0')}`);
  return ids.get(real);
};
const ID_FIELDS = {
  uuid: 'u',
  parentUuid: 'u',
  leafUuid: 'u',
  logicalParentUuid: 'u',
  sourceToolAssistantUUID: 'u',
  sessionId: 's',
  session_id: 's',
  agentId: 'a',
  requestId: 'req',
  promptId: 'p',
  toolUseId: 't',
  toolUseID: 't',
  sourceToolUseID: 't',
  id: 'id',
  tool_use_id: 't',
  bridgeSessionId: 'b',
  runId: 'wf',
  key: 'k',
};

let textCounter = 0;

function anonymize(value, key) {
  if (Array.isArray(value)) return value.map((item) => anonymize(item, key));
  if (value !== null && typeof value === 'object') {
    // Ключом бывает путь файла (мапы вроде trackedFileBackups) — такой ключ тоже приватный.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.includes('/') ? fakeId(k, 'путь-') : k,
        anonymize(v, k),
      ]),
    );
  }
  if (typeof value !== 'string') return value;

  if (key in FIXED) return FIXED[key];
  if (key in ID_FIELDS) return fakeId(value, ID_FIELDS[key]);
  if (KEEP_STRINGS.has(key)) return value;
  // Таймстемпы структурны — по ним считается длительность.
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return value;
  return `текст ${++textCounter}`;
}

async function anonymizeJsonl(src, dst) {
  const lines = [];
  const rl = createInterface({ input: createReadStream(src, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // оборванный хвост живой сессии в фикстуру не тащим
    }
    lines.push(JSON.stringify(anonymize(record, null)));
  }
  await mkdir(path.dirname(dst), { recursive: true });
  await writeFile(dst, `${lines.join('\n')}\n`);
  return lines.length;
}

async function anonymizeMeta(src, dst) {
  const meta = JSON.parse(await readFile(src, 'utf8'));
  await writeFile(dst, JSON.stringify(anonymize(meta, null)));
}

async function findSession(id) {
  for (const project of await readdir(ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const file = path.join(ROOT, project.name, `${id}.jsonl`);
    try {
      await readdir(path.join(ROOT, project.name));
      const entries = await readdir(path.join(ROOT, project.name));
      if (entries.includes(`${id}.jsonl`)) return { project: project.name, file };
    } catch {
      /* каталог мог исчезнуть */
    }
  }
  return null;
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

await rm(OUT, { recursive: true, force: true });

for (const [n, id] of WANTED.entries()) {
  const found = await findSession(id);
  if (!found) {
    console.error(`сессия ${id} не найдена`);
    process.exit(1);
  }
  // Каталог проекта в фикстуре обезличен, имя сессии — порядковый номер.
  const project = `-Users-dev-project-${n + 1}`;
  const sessionName = `session-${n + 1}`;

  const records = await anonymizeJsonl(found.file, path.join(OUT, project, `${sessionName}.jsonl`));
  let subs = 0;

  for (const file of await walk(path.join(ROOT, found.project, id, 'subagents'))) {
    const relative = path.relative(path.join(ROOT, found.project, id), file);
    // Имена файлов и каталогов тоже несут настоящие идентификаторы — перенумеровываем.
    const dst = path.join(
      OUT,
      project,
      sessionName,
      relative
        .split(path.sep)
        .map((segment) =>
          segment.startsWith('agent-')
            ? `agent-${fakeId(segment.slice('agent-'.length).replace(/\.(jsonl|meta\.json)$/, ''), 'a')}${segment.endsWith('.meta.json') ? '.meta.json' : '.jsonl'}`
            : segment.startsWith('wf_')
              ? `wf_${fakeId(segment, 'run')}`
              : segment,
        )
        .join(path.sep),
    );
    if (file.endsWith('.jsonl')) {
      await anonymizeJsonl(file, dst);
      if (path.basename(file).startsWith('agent-')) subs++;
    } else if (file.endsWith('.meta.json')) {
      await mkdir(path.dirname(dst), { recursive: true });
      await anonymizeMeta(file, dst);
    }
  }
  console.log(`${sessionName}: записей ${records}, субагентов ${subs}`);
}

console.log(`\nФикстуры в ${OUT}`);
