// Что человек узнаёт о запуске Code Mode (план T8h, §7): настоящие файлы, подставные PTY и часы.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workPaths } from '@parley/core';
import type { HostNotice, SessionRef } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_MODE_CONFIRM_MS, CODE_MODE_NOTICE_TICK_MS, codeModeNoticeOf, startCodeModeNotices } from './code-mode-notice.js';

const NONCE = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const AT = 1_800_000_000_000;
let root: string;
let ref: SessionRef;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'parley-t8h-notice-'));
  ref = { projectPath: root, workId: 'w-0001', sessionId: 's-01' };
  dir = path.join(workPaths(root, ref.workId).dir, 'code-mode');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

const decide = (over: Record<string, unknown> = {}): void => { writeFileSync(path.join(dir, 's-01.launch.json'), JSON.stringify({ v: 1, nonce: NONCE, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: new Date(AT).toISOString(), ...over })); };
const record = (over: Record<string, unknown> = {}): void => { writeFileSync(path.join(dir, 's-01.exposure.json'), JSON.stringify({ v: 1, effective: 'replacement', reason: null, migrated: [], residual: [], registryRevision: 'r', residualSchemaSha256: null, launchId: null, nonce: NONCE, ...over })); };
const late = AT + CODE_MODE_CONFIRM_MS;

describe('codeModeNoticeOf', () => {
  it('нет решения или оно не разобрано — молчит', () => {
    expect(codeModeNoticeOf(ref, late)).toBeNull();
    writeFileSync(path.join(dir, 's-01.launch.json'), '{"v":1,"non');
    expect(codeModeNoticeOf(ref, late)).toBeNull();
  });
  it('классика без удержания — молчит, что бы ни лежало рядом', () => {
    decide({ nonce: null, effective: 'classic', requested: false, reason: 'not-requested' });
    record({ effective: 'failed', reason: 'partition' });
    expect(codeModeNoticeOf(ref, late)).toBeNull();
  });
  it('классика из-за удержанного прогона — говорит об этом', () => {
    decide({ nonce: null, effective: 'classic', reason: 'held-run' });
    // Один текст на оба случая: держатель может быть ещё жив, и утверждать «не учтён» было бы неправдой (s-290).
    expect(codeModeNoticeOf(ref, AT)?.text).toBe('An earlier Code Mode run in session s-01 may still be finishing or was not accounted for: it runs with its direct tools.');
  });
  it('отказ детектора при запуске — говорит, с причиной из закрытого списка; класс источника назван (T12a, слайс D)', () => {
    decide({ nonce: null, effective: 'classic', reason: 'detector' });
    expect(codeModeNoticeOf(ref, AT)).toEqual({ key: 'refused:detector', text: 'A rule or hook that targets Parley tools is set for this session. Code Mode is off for this launch of session s-01: it runs with its direct tools, and a relaunch checks again.' });
    decide({ nonce: null, effective: 'classic', reason: 'uninspected-source:claude-plugin-hooks' });
    expect(codeModeNoticeOf(ref, AT)).toEqual({ key: 'refused:uninspected-source:claude-plugin-hooks', text: 'A settings or hook source for this session could not be inspected (claude-plugin-hooks). Code Mode is off for this launch of session s-01: it runs with its direct tools, and a relaunch checks again.' });
  });
  it.each(['provider-unproven', 'client-version', 'registry', 'role', 'decision-write-failed', 'uninspected-source:', 'uninspected-source:Bad Class', 'detector-x', null])('классика по причине %j — молчит: о ней скажут строка состояния и метка', (reason) => {
    decide({ nonce: null, effective: 'classic', reason });
    expect(codeModeNoticeOf(ref, late)).toBeNull();
  });
  it('запись этого запуска подтверждает — молчит', () => { decide(); record(); expect(codeModeNoticeOf(ref, late)).toBeNull(); });
  it('запись этого запуска говорит failed — сразу, с кодом', () => {
    decide(); record({ effective: 'failed', reason: 'uninventoried-tool' });
    const notice = codeModeNoticeOf(ref, AT);
    expect(notice?.text).toContain('failed to start');
    expect(notice?.text).toContain('uninventoried-tool');
  });
  it('записи нет — до 30 с молчит, потом «not confirmed», а не «failed»', () => {
    decide();
    expect(codeModeNoticeOf(ref, late - 1)).toBeNull();
    const notice = codeModeNoticeOf(ref, late);
    expect(notice?.text).toContain('not confirmed');
    expect(notice?.text).not.toMatch(/failed/i);
  });
  it('запись первого запуска, а сервер второго умер: «not confirmed», не «ok» и не старый сбой', () => {
    decide({ nonce: OTHER });
    record();
    expect(codeModeNoticeOf(ref, late)?.text).toContain('not confirmed');
    record({ effective: 'failed', reason: 'partition' });
    expect(codeModeNoticeOf(ref, late)?.text).toContain('not confirmed');
  });
  it('время решения не читается — не молчит вечно', () => { decide({ at: 'x' }); expect(codeModeNoticeOf(ref, late)?.text).toContain('not confirmed'); });
});

describe('startCodeModeNotices', () => {
  const start = (list: () => { ref: SessionRef }[]) => {
    vi.useFakeTimers();
    vi.setSystemTime(late);
    const seen: HostNotice[] = [];
    const stop = startCodeModeNotices({ pty: { list } as never, notify: (n) => seen.push(n) });
    return { seen, stop };
  };
  it('один раз на запуск; новый запуск говорит снова; вид code-mode-failed и ссылка на сессию', async () => {
    decide(); record({ effective: 'failed', reason: 'partition' });
    const { seen, stop } = start(() => [{ ref }]);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 3);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'code-mode-failed', ref });
    decide({ nonce: OTHER, at: new Date(Date.now()).toISOString() });
    record({ effective: 'failed', reason: 'partition', nonce: OTHER });
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 3);
    expect(seen).toHaveLength(2);
    await stop();
  });
  it('удержанный прогон — одно уведомление на сессию: следующий запуск с тем же удержанием, в том числе с другой записью, молчит', async () => {
    decide({ nonce: null, effective: 'classic', reason: 'held-run' });
    const { seen, stop } = start(() => [{ ref }]);
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'code-mode-failed', ref });
    decide({ nonce: null, effective: 'classic', reason: 'held-run', at: new Date(Date.now()).toISOString() });
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen).toHaveLength(1);
    await stop();
  });
  it('отказ детектора — один раз на сессию и причину: тот же отказ при следующем запуске молчит, другой говорит снова', async () => {
    decide({ nonce: null, effective: 'classic', reason: 'detector' });
    const { seen, stop } = start(() => [{ ref }]);
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    decide({ nonce: null, effective: 'classic', reason: 'detector', at: new Date(Date.now()).toISOString() });
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen.map((n) => n.text)).toEqual([expect.stringContaining('targets Parley tools')]);
    decide({ nonce: null, effective: 'classic', reason: 'uninspected-source:claude-settings', at: new Date(Date.now()).toISOString() });
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen.map((n) => n.text)).toEqual([expect.stringContaining('targets Parley tools'), expect.stringContaining('(claude-settings)')]);
    expect(seen[1]).toMatchObject({ kind: 'code-mode-failed', ref });
    await stop();
  });
  it('сбой после «не подтверждено» сказан тоже, по порядку; каждое состояние запуска — один раз (s-296 N1)', async () => {
    decide();
    const { seen, stop } = start(() => [{ ref }]);
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen.map((n) => n.text)).toEqual([expect.stringContaining('not confirmed')]);
    record({ effective: 'failed', reason: 'uninventoried-tool' });
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen.map((n) => n.text)).toEqual([expect.stringContaining('not confirmed'), expect.stringContaining('uninventoried-tool')]);
    // Запись снова чужая: «не подтверждено» этого запуска уже сказано.
    record({ nonce: OTHER });
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen).toHaveLength(2);
    await stop();
  });
  it('только живые PTY: сессии без процесса не трогает', async () => {
    decide(); record({ effective: 'failed', reason: 'partition' });
    const { seen, stop } = start(() => []);
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen).toEqual([]);
    await stop();
  });
  it('после остановки молчит', async () => {
    decide(); record({ effective: 'failed', reason: 'partition' });
    const { seen, stop } = start(() => [{ ref }]);
    await stop();
    vi.advanceTimersByTime(CODE_MODE_NOTICE_TICK_MS * 2);
    expect(seen).toEqual([]);
  });
});
