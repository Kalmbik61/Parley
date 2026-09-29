/**
 * Лимиты Codex из логов сессий (спека комнат Organic, 3.5): последнее событие `token_count` с
 * `rate_limits` самого свежего rollout-лога. Формат — по исходникам `openai/codex`
 * (`codex-rs/protocol/src/protocol.rs`: `TokenCountEvent { info, rate_limits }`,
 * `RateLimitWindow { used_percent, window_minutes, resets_at }`, `resets_at` в Unix-секундах) и
 * по снимку схемы `docs/schema/codex-schema-report.json`. Тесты — на выдуманных логах во
 * временном каталоге: настоящие логи человека (там его переписка) не читаются.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexLimitsOf, readCodexLimits } from './limits.js';

const NOW_SEC = Date.parse('2026-09-29T12:00:00.000Z') / 1000;
const AT = '2026-09-29T11:58:00.000Z';

const window = (
  usedPercent: number,
  minutes: number | null,
  resetsAt: number | null = NOW_SEC + 3600,
) => ({
  used_percent: usedPercent,
  window_minutes: minutes,
  resets_at: resetsAt,
});

const both = { primary: window(58, 300), secondary: window(41.2, 10_080, NOW_SEC + 86_400) };

/** Запись `token_count`, как её пишет Codex в rollout-лог. */
const tokenCount = (rateLimits: unknown, at: string = AT, info: unknown = null) => ({
  timestamp: at,
  type: 'event_msg',
  payload: { type: 'token_count', info, rate_limits: rateLimits },
});

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
const chat = (text: string): string =>
  line({
    timestamp: AT,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });

describe('codexLimitsOf: одна запись лога', () => {
  it('primary — пять часов, secondary — неделя; at — время записи, сброс — в ISO', () => {
    expect(codexLimitsOf(tokenCount(both))).toEqual({
      fiveHour: { usedPercent: 58, resetsAt: '2026-09-29T13:00:00.000Z' },
      week: { usedPercent: 41.2, resetsAt: '2026-09-30T12:00:00.000Z' },
      at: AT,
    });
  });

  it('окно определяется по window_minutes, а не по имени поля', () => {
    const swapped = codexLimitsOf(
      tokenCount({ primary: window(41, 10_080, NOW_SEC + 86_400), secondary: window(58, 300) }),
    );
    expect(swapped?.fiveHour?.usedPercent).toBe(58);
    expect(swapped?.week?.usedPercent).toBe(41);

    // Только недельное окно в поле primary — пятичасового нет.
    const onlyWeek = codexLimitsOf(tokenCount({ primary: window(12, 10_080), secondary: null }));
    expect(onlyWeek?.fiveHour).toBeNull();
    expect(onlyWeek?.week?.usedPercent).toBe(12);
  });

  it('длина окна чуть иная (5 %, как у самого Codex при подписи окон) — то же окно', () => {
    const near = codexLimitsOf(
      tokenCount({ primary: window(5, 299), secondary: window(6, 10_079) }),
    );
    expect(near?.fiveHour?.usedPercent).toBe(5);
    expect(near?.week?.usedPercent).toBe(6);
  });

  it('окна других размеров (сутки, месяц) и без длины или сброса не показываются', () => {
    expect(
      codexLimitsOf(tokenCount({ primary: window(5, 1440), secondary: window(6, 43_200) })),
    ).toBeNull();
    expect(codexLimitsOf(tokenCount({ primary: window(5, null), secondary: null }))).toBeNull();
    expect(
      codexLimitsOf(tokenCount({ primary: window(5, 300, null), secondary: null })),
    ).toBeNull();
    // Окно без сброса не мешает соседу.
    expect(
      codexLimitsOf(tokenCount({ primary: window(5, 300, null), secondary: window(6, 10_080) }))
        ?.week?.usedPercent,
    ).toBe(6);
  });

  it('не token_count, rate_limits: null и запись без времени — null', () => {
    expect(codexLimitsOf(tokenCount(null))).toBeNull();
    expect(codexLimitsOf({ ...tokenCount(both), type: 'response_item' })).toBeNull();
    expect(
      codexLimitsOf({ ...tokenCount(both), payload: { type: 'user_message', rate_limits: both } }),
    ).toBeNull();
    expect(codexLimitsOf(tokenCount(both, 'вчера'))).toBeNull();
    expect(codexLimitsOf({ type: 'event_msg', payload: tokenCount(both).payload })).toBeNull();
    expect(codexLimitsOf('строка')).toBeNull();
    expect(codexLimitsOf(null)).toBeNull();
  });
});

describe('readCodexLimits: самый свежий rollout-лог', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-codex-limits-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Кладёт лог в <root>/<Y>/<M>/<D>/, как Codex; время изменения — `modified` (или сейчас). */
  async function rollout(
    day: string,
    name: string,
    body: string,
    modified?: string,
  ): Promise<string> {
    const dir = path.join(root, ...day.split('-'));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-${day}T10-00-00-${name}.jsonl`);
    await writeFile(file, body);
    if (modified !== undefined) {
      const stamp = new Date(modified);
      await utimes(file, stamp, stamp);
    }
    return file;
  }

  it('последнее событие token_count с rate_limits, а не первое', async () => {
    await rollout(
      '2026-09-29',
      '019a0000-0000-7000-8000-000000000001',
      chat('привет') +
        line(
          tokenCount(
            { primary: window(10, 300), secondary: window(5, 10_080) },
            '2026-09-29T10:01:00.000Z',
          ),
        ) +
        chat('ещё') +
        line(tokenCount({ primary: window(58, 300), secondary: window(41.2, 10_080) }, AT)) +
        chat('и ещё'),
    );

    const limits = await readCodexLimits(root);
    expect(limits?.fiveHour?.usedPercent).toBe(58);
    expect(limits?.week?.usedPercent).toBe(41.2);
    expect(limits?.at).toBe(AT);
  });

  it('последний token_count без rate_limits (info: null у других планов) не затирает предыдущий', async () => {
    await rollout(
      '2026-09-29',
      '019a0000-0000-7000-8000-000000000002',
      line(tokenCount(both, AT)) + line(tokenCount(null, '2026-09-29T11:59:00.000Z')),
    );

    expect((await readCodexLimits(root))?.at).toBe(AT);
  });

  it('свежесть — по времени изменения файла: возобновлённая сессия из старого каталога дня побеждает', async () => {
    // Старый день, но файл дописывали только что: `codex resume` продолжает тот же rollout.
    await rollout(
      '2026-09-20',
      '019a0000-0000-7000-8000-000000000003',
      line(tokenCount({ primary: window(70, 300) }, '2026-09-29T11:59:00.000Z')),
      '2026-09-29T11:59:00.000Z',
    );
    await rollout(
      '2026-09-29',
      '019a0000-0000-7000-8000-000000000004',
      line(tokenCount({ primary: window(20, 300) }, '2026-09-29T09:00:00.000Z')),
      '2026-09-29T09:00:00.000Z',
    );

    expect((await readCodexLimits(root))?.fiveHour?.usedPercent).toBe(70);
  });

  it('у самого свежего лога событий с лимитами ещё нет — берётся следующий по свежести', async () => {
    await rollout(
      '2026-09-29',
      '019a0000-0000-7000-8000-000000000005',
      chat('начало сессии, ход ещё не закончен'),
      '2026-09-29T11:59:30.000Z',
    );
    await rollout(
      '2026-09-29',
      '019a0000-0000-7000-8000-000000000006',
      line(tokenCount(both, AT)),
      '2026-09-29T11:00:00.000Z',
    );

    expect((await readCodexLimits(root))?.at).toBe(AT);
  });

  it('чужие .jsonl без имени rollout-* не читаются', async () => {
    await mkdir(path.join(root, '2026', '09', '29'), { recursive: true });
    await writeFile(path.join(root, '2026', '09', '29', 'notes.jsonl'), line(tokenCount(both)));

    expect(await readCodexLimits(root)).toBeNull();
  });

  it('корня нет или он пуст — null, без ошибки', async () => {
    expect(await readCodexLimits(path.join(root, 'нет-такого'))).toBeNull();
    expect(await readCodexLimits(root)).toBeNull();
  });

  it('недописанная последняя строка (Codex дописывает лог прямо сейчас) не мешает предыдущей', async () => {
    const half = line(tokenCount({ primary: window(99, 300) }, '2026-09-29T11:59:59.000Z')).slice(
      0,
      60,
    );
    await rollout(
      '2026-09-29',
      '019a0000-0000-7000-8000-000000000007',
      line(tokenCount(both, AT)) + half,
    );

    expect((await readCodexLimits(root))?.at).toBe(AT);
  });

  describe('большой лог: читается хвост, а не файл целиком', () => {
    /** Строки-наполнитель с кириллицей: двухбайтовые символы попадают на границу среза. */
    const filler = (bytes: number): string =>
      chat('вода '.repeat(200)).repeat(Math.ceil(bytes / 2200));

    it('событие в последних мегабайтах большого файла находится', async () => {
      await rollout(
        '2026-09-29',
        '019a0000-0000-7000-8000-000000000008',
        filler(20 * 1024 * 1024) + line(tokenCount(both, AT)) + filler(300 * 1024),
      );

      expect((await readCodexLimits(root))?.at).toBe(AT);
    });

    it('событие в самом начале 20-мегабайтного файла не ищется: файл целиком не читается', async () => {
      await rollout(
        '2026-09-29',
        '019a0000-0000-7000-8000-000000000009',
        line(tokenCount(both, AT)) + filler(20 * 1024 * 1024),
      );

      expect(await readCodexLimits(root)).toBeNull();
    });
  });
});
