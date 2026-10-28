// Тесты разбора заметок релизов для сайта: node --test scripts/site/releases.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  firstSentence,
  formatDate,
  parseReleaseNotes,
  pickReleases,
  stripInline,
  toReleaseCard,
} from '../../site/js/releases.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/releases.json', import.meta.url), 'utf8'),
);
const byTag = Object.fromEntries(fixture.map((release) => [release.tag_name, release]));

test('таблица §6.3: summary и число пунктов по настоящим заметкам', () => {
  const expected = {
    'v0.24.0': { summary: "The assistant's voice can use the larger Qwen3-TTS 1.7B model", counts: [2, 0, 1, 1] },
    'v0.23.0': { summary: 'The assistant gets hands:', counts: [6, 2, 5, 1] },
    'v0.22.0': { summary: 'The largest release so far.', counts: [12, 9, 2, 2] },
    'v0.21.0': { summary: 'A second Claude Code account of yours as a provider', counts: [4, 5, 0, 0] },
  };
  for (const [tag, want] of Object.entries(expected)) {
    const notes = parseReleaseNotes(byTag[tag].body);
    assert.ok(notes.summary.startsWith(want.summary), `${tag}: summary «${notes.summary.slice(0, 60)}»`);
    assert.deepEqual(
      [notes.added.length, notes.changed.length, notes.fixed.length, notes.notProven.length],
      want.counts,
      tag,
    );
  }
});

test('v0.24.0: первый пункт Added и текст «not proven»', () => {
  const notes = parseReleaseNotes(byTag['v0.24.0'].body);
  assert.deepEqual(notes.added[0], {
    title: 'Qwen3-TTS 1.7B voice',
    text:
      'Settings → Assistant → Voice lists the 0.6B and 1.7B models, each with its own Download, Cancel, Delete and progress. ' +
      'The assistant speaks with the largest downloaded model; nothing downloads on its own.',
  });
  assert.ok(
    notes.added[1].title.startsWith('Sleeping sessions (no process; Resume wakes them) show'),
  );
  assert.equal(notes.added[1].text, '');
  assert.deepEqual(notes.notProven, [
    'How fast the 1.7B voice speaks on a real machine has not been measured.',
  ]);
});

test('пункт без жирного заголовка: title — первое предложение, не длиннее 110 и с «…»', () => {
  const { added } = parseReleaseNotes(byTag['v0.24.0'].body);
  const full = 'Sleeping sessions (no process; Resume wakes them) show 💤 in the sidebar instead of their last result\'s glyph, with an "Asleep" tooltip.';
  assert.ok(full.length > 110);
  assert.ok(added[1].title.length <= 111);
  assert.ok(added[1].title.endsWith('…'));
});

test('пустое и null-тело', () => {
  for (const body of [null, undefined, '', '   \n\n']) {
    assert.deepEqual(parseReleaseNotes(body), {
      summary: '',
      added: [],
      changed: [],
      fixed: [],
      notProven: [],
    });
  }
});

test('тело с \\r\\n', () => {
  const body = 'Short intro.\r\n\r\n### Added\r\n\r\n- **First.** One text.\r\n- Second item. More.\r\n\r\n### What is not proven yet\r\n\r\n- Not run live.\r\n';
  const notes = parseReleaseNotes(body);
  assert.equal(notes.summary, 'Short intro.');
  assert.deepEqual(notes.added, [
    { title: 'First', text: 'One text.' },
    { title: 'Second item.', text: '' },
  ]);
  assert.deepEqual(notes.notProven, ['Not run live.']);
});

test('тело без разделов: только summary', () => {
  const notes = parseReleaseNotes('Just a paragraph\nover two lines.\n\nAnother paragraph.');
  assert.equal(notes.summary, 'Just a paragraph over two lines.');
  assert.deepEqual([notes.added, notes.changed, notes.fixed, notes.notProven], [[], [], [], []]);
});

test('тело, которое начинается с заголовка, summary пустой', () => {
  assert.equal(parseReleaseNotes('### Added\n\n- One.\n').summary, '');
});

test('вложенные пункты не считаются, их строки не дописываются к родителю', () => {
  const body = [
    'Intro.',
    '',
    '### Added',
    '',
    '- **Parent.** Parent text',
    '  continues here.',
    '  - nested one',
    '    wrapped nested line',
    '  - nested two',
    '- Second top item.',
    '',
  ].join('\n');
  const { added } = parseReleaseNotes(body);
  assert.equal(added.length, 2);
  assert.deepEqual(added[0], { title: 'Parent', text: 'Parent text continues here.' });
  assert.equal(added[1].title, 'Second top item.');
});

test('остальные разделы пропускаются', () => {
  const body = 'Intro.\n\n### Added\n\n- A.\n\n### Updating\n\n- Do this.\n\n### Known issues\n\n- Broken.\n\n### Fixed\n\n- F.\n';
  const notes = parseReleaseNotes(body);
  assert.equal(notes.added.length, 1);
  assert.equal(notes.fixed.length, 1);
  assert.deepEqual(notes.notProven, []);
});

test('ссылки на PR срезаются, остальные ссылки остаются текстом', () => {
  const body = [
    'Intro.',
    '',
    '### Fixed',
    '',
    '- **One.** Fixed a thing, see [the docs](https://example.com/docs). ([#123](https://github.com/o/r/pull/123))',
    '- Another one. ([#124](https://github.com/o/r/pull/124), [#125](https://github.com/o/r/pull/125))',
    '',
  ].join('\n');
  const { fixed } = parseReleaseNotes(body);
  assert.deepEqual(fixed[0], { title: 'One', text: 'Fixed a thing, see the docs.' });
  assert.equal(fixed[1].title, 'Another one.');
});

test('жирный заголовок: без ** и без точки или двоеточия в конце', () => {
  const body = 'x\n\n### Added\n\n- **With colon:** body\n- **With `code`.** body 2\n';
  const { added } = parseReleaseNotes(body);
  assert.deepEqual(added, [
    { title: 'With colon', text: 'body' },
    { title: 'With code', text: 'body 2' },
  ]);
});

test('stripInline: ссылки, жирный, подчёркивания, обратные кавычки', () => {
  assert.equal(
    stripInline('A [link](https://x.y/z), **bold**, __also__ and `code`'),
    'A link, bold, also and code',
  );
});

test('firstSentence: до первой точки с пробелом, без обрезки коротких', () => {
  assert.equal(firstSentence('One. Two. Three.', 50), 'One.');
  assert.equal(firstSentence('Version 1.7B is out. More.', 50), 'Version 1.7B is out.');
  assert.equal(firstSentence('No period here', 50), 'No period here');
});

test('firstSentence: длинное обрезает по слову и ставит «…»', () => {
  const out = firstSentence('The assistant voice can use the larger model and sleeping sessions', 30);
  assert.equal(out, 'The assistant voice can use…');
  assert.ok(out.length <= 31);
});

test('formatDate: Oct 28, 2026', () => {
  assert.equal(formatDate('2026-10-28T16:58:26Z'), 'Oct 28, 2026');
  assert.equal(formatDate('2026-10-27T23:59:59Z'), 'Oct 27, 2026');
  assert.equal(formatDate('not a date'), '');
});

test('pickReleases: убирает draft и prerelease, сортирует по дате, режет по limit', () => {
  const list = [
    { tag_name: 'v1', published_at: '2026-01-01T00:00:00Z' },
    { tag_name: 'v3', published_at: '2026-03-01T00:00:00Z' },
    { tag_name: 'draft', draft: true, published_at: '2026-09-01T00:00:00Z' },
    { tag_name: 'pre', prerelease: true, published_at: '2026-08-01T00:00:00Z' },
    { tag_name: 'v2', published_at: '2026-02-01T00:00:00Z' },
  ];
  assert.deepEqual(pickReleases(list).map((r) => r.tag_name), ['v3', 'v2', 'v1']);
  assert.deepEqual(pickReleases(list, 2).map((r) => r.tag_name), ['v3', 'v2']);
  assert.equal(list[0].tag_name, 'v1', 'входной массив не меняется');
  assert.deepEqual(pickReleases(null), []);
});

test('pickReleases по фикстуре: новые первыми', () => {
  assert.deepEqual(
    pickReleases(fixture).map((r) => r.tag_name),
    ['v0.24.0', 'v0.23.0', 'v0.22.0', 'v0.21.0'],
  );
});

test('toReleaseCard: версия без v, highlights не больше четырёх, счётчики', () => {
  const card = toReleaseCard(byTag['v0.22.0']);
  assert.equal(card.tag, 'v0.22.0');
  assert.equal(card.version, '0.22.0');
  assert.equal(card.name, 'Parley 0.22.0');
  assert.equal(card.url, 'https://github.com/Kalmbik61/Parley/releases/tag/v0.22.0');
  assert.equal(card.date, '2026-10-27T21:55:02Z');
  assert.equal(card.highlights.length, 4);
  assert.equal(card.highlights[0].title, 'Autonomous rooms (stage 1)');
  assert.deepEqual(card.counts, { added: 12, changed: 9, fixed: 2 });
  assert.equal(card.notProven.length, 2);
  assert.ok(card.summary.startsWith('The largest release so far.'));
});
