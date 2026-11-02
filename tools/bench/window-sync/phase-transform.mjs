import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');

function wrapped(source, file, select) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const edits = [], phases = [];
  function visit(node) {
    const phase = select(node);
    if (phase && node.body && ts.isBlock(node.body)) {
      const start = node.body.getStart(ast) + 1, end = node.body.end - 1;
      const prefix = `\nconst __p7Start = globalThis.__p7Node?.observed ? performance.now() : undefined; try {\n`;
      const suffix = `\n} finally { if (__p7Start !== undefined) globalThis.__p7Node.sample(${JSON.stringify(phase)}, __p7Start); }\n`;
      edits.push({ at: start, text: prefix }, { at: end, text: suffix }); phases.push(phase);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const edit of edits.sort((a, b) => b.at - a.at)) source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  return { source, phases };
}
export function observeCoreSource(source) {
  return wrapped(source, 'context-pages.js', node => {
    if (!ts.isFunctionDeclaration(node)) return;
    return ({ mailWorkMap: 'host-legacy-mail-projection', compactWorkMap: 'host-legacy-compact-projection', captureWindowMail: 'host-mail-capture' })[node.name?.text];
  });
}
export function observeRootsSource(source) {
  return wrapped(source, 'roots.ts', node => {
    if (!ts.isArrowFunction(node) || node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent)) return ({ reconcile: 'roots-reconcile', apply: 'legacy-roots-apply-start' })[parent.name.getText()];
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === 'then') {
      for (let owner = parent; owner; owner = owner.parent) if (ts.isVariableDeclaration(owner) && owner.name.getText() === 'apply') return 'legacy-roots-install';
    }
  });
}
