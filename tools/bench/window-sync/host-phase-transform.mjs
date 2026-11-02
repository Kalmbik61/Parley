// Fixture-only spans measure synchronous work only. Cooperative async routines are
// sampled at existing generator.next boundaries by cooperative-profiler.mjs.
import ts from 'typescript';

function editSource(source, edits) {
  for (const edit of edits.sort((a, b) => b.at - a.at)) source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  return source;
}

function findFunction(source, file, name) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let target;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(ast).replaceAll(/["']/g, '') === name) target ??= node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!target?.body) throw new Error(`Missing host phase target ${name} in ${file}`);
  return { ast, target };
}

function wrapCaptureCallback(source) {
  const { ast, target } = findFunction(source, 'works-service.js', 'captureSync');
  let callback;
  function visit(node) {
    if (ts.isArrowFunction(node) && node.parameters[0]?.name.getText(ast) === 'work' && node.body && ts.isBlock(node.body)) callback ??= node;
    ts.forEachChild(node, visit);
  }
  visit(target.body);
  if (!callback) throw new Error('Missing captureWorks per-work callback');
  const body = callback.body;
  return editSource(source, [
    { at: body.getStart(ast) + 1, text: `return globalThis.__p7Node.phaseSync('host.capture-sync-db-mail', () => {\n` },
    { at: body.end - 1, text: '\n}, { workId: work.map.work.id, sourceVersion: work.version });\n' },
  ]);
}

function wrapContext(source, file, text, phase, detail) {
  const at = source.indexOf(text);
  if (at < 0 || source.indexOf(text, at + text.length) >= 0) throw new Error(`Expected one ${text} in ${file}`);
  const expression = text.replace(/^await\s+/, '');
  return source.slice(0, at) + `await globalThis.__p7Node.withPhaseContext({ phaseName: ${JSON.stringify(phase)}, ${detail} }, () => (${expression}))` + source.slice(at + text.length);
}

function wrapRecordWalk(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let target;
  function visit(node) {
    if (ts.isForOfStatement(node) && node.awaitModifier && node.expression.getText(ast).includes('rows.records(key, this.revision)')) target ??= node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!target || !ts.isBlock(target.statement) || target.statement.statements.some(s => s.getText(ast).includes('await '))) throw new Error(`Missing synchronous records byte-walk loop in ${file}`);
  const body = target.statement;
  return editSource(source, [
    { at: body.getStart(ast) + 1, text: `globalThis.__p7Node.phaseSync('host.publish.records-byte-walk', () => {\n` },
    { at: body.end - 1, text: `\n}, { workId: key.workId, structuralRevision: this.revision });\n` },
  ]);
}

export function observeHostPhases(files) {
  let service = wrapCaptureCallback(files.service);
  service = wrapContext(service, 'works-service.js', 'await projectWindowMail(work.map, mail)', 'host.project-mail', 'workId: work.map.work.id, sourceVersion: work.version');

  let sync = files.sync;
  sync = wrapContext(sync, 'works-sync.js', 'await this.rows.fork()', 'host.syncrows.fork-copy', 'structuralRevision: this.revision + 1');
  sync = wrapContext(sync, 'works-sync.js', 'await rows.update(key, entry.map, entry.version, nextRevision)', 'host.syncrows.update', 'workId: key.workId, sourceVersion: entry.version, structuralRevision: nextRevision');
  sync = wrapContext(sync, 'works-sync.js', 'await task.run(metadata())', 'host.publish.metadata-journal', 'structuralRevision: nextRevision');
  sync = wrapContext(sync, 'works-sync.js', 'await rows.prune(floor)', 'host.syncrows.prune', 'structuralRevision: floor');
  sync = sync.replace('this.rows.adopt(candidate.rows);', "globalThis.__p7Node.phaseSync('host.syncrows.adopt', () => this.rows.adopt(candidate.rows), { structuralRevision: candidate.nextRevision });");
  sync = wrapRecordWalk(sync, 'works-sync.js');

  let rows = files.rows;
  rows = wrapContext(rows, 'sync-rows.js', 'await cloneWindowValue(source, task)', 'host.syncrows.clone-window-value', 'workId: key.workId, sourceVersion, structuralRevision: revision');
  rows = wrapContext(rows, 'sync-rows.js', 'await task.run(build())', 'host.syncrows.equality-index-build', 'workId: key.workId, sourceVersion, structuralRevision: revision');
  return { service, sync, rows, phases: [
    'host.db-map-write-transaction (shared fixture wrapper)', 'host.capture-sync-db-mail', 'host.project-mail',
    'host.syncrows.fork-copy', 'host.syncrows.update', 'host.syncrows.clone-window-value',
    'host.syncrows.equality-index-build', 'host.publish.records-byte-walk', 'host.publish.metadata-journal',
    'host.syncrows.prune', 'host.syncrows.adopt',
  ] };
}
