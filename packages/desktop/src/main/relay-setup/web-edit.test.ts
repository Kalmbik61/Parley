import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caddyBlockAppend, removeCaddyBlock, sha256 } from './templates.js';
import { afterShaOf, buildEditScript, caddyCommands, editCommand, EDIT_EXIT, FILE_CHANGED, webStepCheck, type EditAction } from './web-edit.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'web-edit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Run {
  status: number | null;
  stderr: string;
}

function run(over: { action: EditAction; target: string; content: string; before: string | null; check?: string | null; reload?: string; after?: string | null }): Run {
  const existing = over.before === null || !existsSync(over.target) ? null : readFileSync(over.target, 'utf8');
  const script = buildEditScript({
    action: over.action,
    target: over.target,
    beforeSha: over.before,
    content: over.content,
    afterSha: over.after !== undefined ? over.after : afterShaOf(over.action, over.content, existing),
    check: over.check === undefined ? 'true' : over.check,
    reload: over.reload ?? 'true',
    backupDir: path.join(dir, 'backups'),
  });
  const file = path.join(dir, 'script.sh');
  writeFileSync(file, script);
  const result = spawnSync('/bin/sh', [file], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

const backups = (): string[] => (existsSync(path.join(dir, 'backups')) ? readdirSync(path.join(dir, 'backups')) : []);

describe('buildEditScript (spec 5.2)', () => {
  it('replaces in place: the backup is byte for byte, the inode stays', () => {
    const target = path.join(dir, 'parley-relay.caddy');
    writeFileSync(target, 'old\n');
    const inode = statSync(target).ino;
    const result = run({ action: 'replace', target, content: 'new\n', before: sha256('old\n') });
    expect(result.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(statSync(target).ino).toBe(inode);
    const [name] = backups();
    expect(name).toMatch(/^\d{8}-\d{6}-parley-relay\.caddy$/);
    expect(readFileSync(path.join(dir, 'backups', name ?? ''), 'utf8')).toBe('old\n');
  });
  it('a failed check restores the file and says so', () => {
    const target = path.join(dir, 'f');
    writeFileSync(target, 'old\n');
    const inode = statSync(target).ino;
    const result = run({ action: 'replace', target, content: 'new\n', before: sha256('old\n'), check: 'false' });
    expect(result.status).toBe(EDIT_EXIT.check);
    expect(result.stderr).toContain('check failed: the file was restored');
    expect(readFileSync(target, 'utf8')).toBe('old\n');
    expect(statSync(target).ino).toBe(inode);
  });
  it('a failed reload restores the file and says so', () => {
    const target = path.join(dir, 'f');
    writeFileSync(target, 'old\n');
    const result = run({ action: 'replace', target, content: 'new\n', before: sha256('old\n'), reload: 'false' });
    expect(result.status).toBe(EDIT_EXIT.reload);
    expect(result.stderr).toContain('reload failed: the file was restored');
    expect(readFileSync(target, 'utf8')).toBe('old\n');
  });
  it('no check at all (Caddy under systemd): only the reload decides', () => {
    const target = path.join(dir, 'f');
    expect(run({ action: 'add', target, content: 'x\n', before: null, check: null }).status).toBe(0);
    rmSync(target);
    expect(run({ action: 'add', target, content: 'x\n', before: null, check: null, reload: 'false' }).status).toBe(EDIT_EXIT.reload);
    expect(existsSync(target)).toBe(false);
  });
  it('a new file is removed when the check fails; with a good check it stays and no backup is made', () => {
    const target = path.join(dir, 'new.caddy');
    expect(run({ action: 'add', target, content: 'x\n', before: null, check: 'false' }).status).toBe(EDIT_EXIT.check);
    expect(existsSync(target)).toBe(false);
    expect(run({ action: 'add', target, content: 'x\n', before: null }).status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('x\n');
    expect(backups()).toEqual([]);
  });
  it('a file that changed since the probe: exit before any write or backup', () => {
    const target = path.join(dir, 'f');
    writeFileSync(target, 'changed by somebody\n');
    const result = run({ action: 'replace', target, content: 'new\n', before: sha256('old\n') });
    expect(result.status).toBe(EDIT_EXIT.changed);
    expect(result.stderr).toContain(FILE_CHANGED);
    expect(readFileSync(target, 'utf8')).toBe('changed by somebody\n');
    expect(backups()).toEqual([]);
    // A file appeared where the probe saw none.
    expect(run({ action: 'add', target, content: 'x\n', before: null }).status).toBe(EDIT_EXIT.changed);
  });
  it.each([
    ['with a final newline', 'example.com {\n\trespond "ok"\n}\n'],
    ['without a final newline', 'example.com {\n\trespond "ok"\n}'],
    ['empty', ''],
  ])('append then remove-block returns the original sha256 (%s)', (_name, original) => {
    const target = path.join(dir, 'Caddyfile');
    writeFileSync(target, original);
    const inode = statSync(target).ino;
    const appended = caddyBlockAppend(original, 'relay.example.com', 'parley-relay:8787');
    expect(run({ action: 'append', target, content: appended, before: sha256(original) }).status).toBe(0);
    const withBlock = readFileSync(target, 'utf8');
    expect(withBlock).toBe(original + appended);
    const without = removeCaddyBlock(withBlock);
    expect(without).toBe(original);
    expect(run({ action: 'remove-block', target, content: without ?? '', before: sha256(withBlock) }).status).toBe(0);
    expect(sha256(readFileSync(target, 'utf8'))).toBe(sha256(original));
    expect(statSync(target).ino).toBe(inode);
  });
  it('remove-block leaves every other byte alone, including text added after our block', () => {
    const original = 'a.com {\n}\n';
    const withBlock = original + caddyBlockAppend(original, 'r.example.com', 'parley-relay:8787') + 'b.com {\n\tx\n}\n';
    const target = path.join(dir, 'Caddyfile');
    writeFileSync(target, withBlock);
    const without = removeCaddyBlock(withBlock);
    expect(without).toBe(`${original}b.com {\n\tx\n}\n`);
    expect(run({ action: 'remove-block', target, content: without ?? '', before: sha256(withBlock) }).status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(`${original}b.com {\n\tx\n}\n`);
  });
  it('remove deletes the file; a failed reload brings it back', () => {
    const target = path.join(dir, 'parley-relay.caddy');
    writeFileSync(target, 'ours\n');
    expect(run({ action: 'remove', target, content: '', before: sha256('ours\n'), reload: 'false' }).status).toBe(EDIT_EXIT.reload);
    expect(readFileSync(target, 'utf8')).toBe('ours\n');
    expect(run({ action: 'remove', target, content: '', before: sha256('ours\n') }).status).toBe(0);
    expect(existsSync(target)).toBe(false);
  });
  it("paths with spaces and quotes do not break the script, and the check sees the new content", () => {
    const sub = path.join(dir, "it's a dir");
    mkdirSync(sub);
    const target = path.join(sub, 'parley relay.caddy');
    const result = run({ action: 'add', target, content: "it's\n", before: null, check: `grep -q "it's" ${JSON.stringify(target)}` });
    expect(result.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe("it's\n");
  });
  it('the script has no backslash and is sent as base64 into sh', () => {
    const script = buildEditScript({ action: 'add', target: '/a/b', beforeSha: null, content: 'x', afterSha: sha256('x'), check: null, reload: 'true' });
    expect(script).not.toContain('\\');
    expect(script.startsWith('set -eu\n')).toBe(true);
    expect(editCommand(script)).toMatch(/^printf %s '[A-Za-z0-9+/=]+' \| base64 -d \| sh$/);
  });
});

describe('Caddy commands', () => {
  const id = 'c1'.repeat(32);
  it('Docker: validate and reload through docker exec with the container path and --address', () => {
    expect(caddyCommands({ runtime: 'docker', containerId: id, containerFile: '/etc/caddy/Caddyfile', admin: '127.0.0.1:2019' })).toEqual({
      check: `docker exec '${id}' caddy validate --config '/etc/caddy/Caddyfile' --adapter caddyfile`,
      reload: `docker exec '${id}' caddy reload --config '/etc/caddy/Caddyfile' --adapter caddyfile --address '127.0.0.1:2019'`,
    });
  });
  it('systemd: no separate check, systemctl reload caddy', () => {
    expect(caddyCommands({ runtime: 'host', containerId: null, containerFile: null, admin: '127.0.0.1:2019' })).toEqual({ check: null, reload: 'systemctl reload caddy' });
  });
  it('the step check compares the sha and asks the admin API (wget in the container, curl on the host)', () => {
    const docker = webStepCheck('/opt/x/y.caddy', 'a'.repeat(64), { runtime: 'docker', containerId: id, containerFile: '/c', admin: '127.0.0.1:2019' }, 'r.example.com');
    expect(docker).toContain(`docker exec '${id}' wget -qO- 'http://127.0.0.1:2019/config/' | grep -qF 'r.example.com'`);
    expect(docker).toContain(`= '${'a'.repeat(64)}' ]`);
    expect(webStepCheck('/x', 'b'.repeat(64), { runtime: 'host', containerId: null, containerFile: null, admin: '127.0.0.1:2019' }, 'r.example.com')).toContain("curl -s 'http://127.0.0.1:2019/config/'");
  });
});
