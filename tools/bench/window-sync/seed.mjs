import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [sourceRoot, home, shape = 'small'] = process.argv.slice(2);
if (!home?.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('Owned temporary fixture home required');
await fs.mkdir(home, { recursive: true }); process.env.PARLEY_HOME = home;
const core = await import(pathToFileURL(path.join(sourceRoot, 'packages/core/dist/index.js')).href);
const specs = { small: { works: 2, total: 20, text: 128 }, short3k: { works: 30, total: 3000, text: 128 }, cold30: { works: 30, total: 3000, text: 4096 }, cold1: { works: 1, total: 3000, text: 4096 }, nearcap: { works: 1, total: 64, text: 15000 }, huge: { works: 1, total: 20, text: 128, huge: 2 * 1024 * 1024 } };
const spec = specs[shape]; if (!spec) throw new Error('Unknown shape');
const project = path.join(home, 'project'); await fs.mkdir(project); await fs.writeFile(path.join(project, 'fixture.txt'), 'P7 synthetic file');
const ids = [];
for (let w = 0; w < spec.works; w += 1) {
  const created = await core.createWork(project, { title: `P7-${w}`, goal: 'synthetic' }); ids.push(created.work.id);
  await core.updateMap(project, created.work.id, map => {
    const count = Math.floor(spec.total / spec.works) + (w < spec.total % spec.works ? 1 : 0);
    for (let s = 0; s < count; s += 1) {
      const session = core.addSession(map, { provider: 'codex', label: `fixture-${s}`, task: (`task-${w}-${s}:` + 'x'.repeat(spec.text)).slice(0, spec.text) });
      session.summary = 's'.repeat(spec.text); session.summarySource = 'agent'; session.lifecycle = 'closed'; session.result = 'done';
    }
    if (spec.huge) {
      // A single long goal is compacted by the existing32KiB projection and cannot
      // exercise fragmentation. Multiple valid artifact paths retain a huge row.
      const unicode = '漢💬"\\'.repeat(2800);
      map.sessions[0].artifacts = Array.from({ length: 80 }, (_, i) => ({ kind: 'p7-synthetic', path: `${i}:${unicode}` }));
      // Root extension metadata is deliberately preserved by the generic map contract.
      map.p7HugeMetadata = '漢💬"\\'.repeat(Math.ceil(spec.huge / 9));
    }
  });
  if (spec.works === 30 && w < 20) await core.setWorkStatus(project, created.work.id, 'archived');
}
core.closeWorkDb();
const fixture = { shape, spec, project, ids, providerProcesses: 'none; all synthetic sessions lifecycle closed/result done' };
await fs.writeFile(path.join(home, 'fixture.json'), JSON.stringify(fixture, null, 2));
process.stdout.write(JSON.stringify({ fixture: path.join(home, 'fixture.json'), ...spec }) + '\n');
