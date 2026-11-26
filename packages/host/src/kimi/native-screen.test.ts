import { expect, it } from 'vitest';
import { kimiComposer, kimiLazyStartup, kimiScreenVersion, kimiModeMenu, kimiPermissionMenu, kimiQuestionMenu } from './native-screen.js';

const screen = [
  ' ● SHARED_REPLY_',
  ' ╭────────────────────╮',
  ' │ >                  │',
  ' ╰────────────────────╯',
  ' parley-offline-fixture  @: mention files',
  '          context: 1% (100/256k)',
];

it('requires the current composer, not just a matching line in an old viewport', () => {
  expect(kimiComposer(screen)).toEqual({ empty: true });
  expect(kimiComposer(screen.toSpliced(1, 0, ' ⠋ Working for 1s'))).toBeUndefined();
  expect(kimiComposer(screen.toSpliced(1, 0, 'Trust this folder?'))).toBeUndefined();
  expect(kimiComposer(screen.toSpliced(2, 1, ' │ > A draft          │'))).toEqual({ empty: false });
  expect(kimiComposer(screen.toSpliced(2, 1, ' │ > Trust this folder? │'))).toEqual({ empty: false });
  expect(kimiComposer(screen.toSpliced(2, 0, 'foo'))).toBeUndefined();
  expect(kimiComposer([...screen, '   ▶ 1. Approve once'])).toBeUndefined();
});

it('recognizes the actual stock scrolled draft with a blank first visible row', () => {
  const draft = screen.toSpliced(1, 2, ' ╭───── ↑ 2 more ─────╮', ' │ >                  │',
    ...Array.from({ length: 6 }, () => ' │   continuation     │'));
  expect(kimiComposer(draft)).toEqual({ empty: false });
  expect(kimiComposer(draft.toSpliced(3, 6))).toEqual({ empty: false });
  expect(kimiComposer([...draft, 'Select permission mode'])).toBeUndefined();
});

it('recognizes exact native labels and order only beside the requested action', () => {
  const dialog = [
    '   ▶ Approve fixture?',
    '   Approve fixture',
    '   ▶ 1. Approve once',
    '     2. Approve for this session',
    '     3. Reject',
    '     4. Reject with feedback',
  ];
  const menu = kimiPermissionMenu(dialog, 'Approve fixture');
  expect(menu?.options.map(({ name }) => name)).toEqual(['Approve once', 'Approve for this session', 'Reject', 'Reject with feedback']);
  expect(menu?.options.map(({ optionId }) => optionId)).toEqual(['1', '2', '3', '4']);
  expect(kimiPermissionMenu(dialog, 'Approve another')).toBeUndefined();
  expect(kimiPermissionMenu(dialog.toSpliced(5, 1, '     4. Allow forever'), 'Approve fixture')).toBeUndefined();
});

it('does not confuse the highlighted permission mode with the current one', () => {
  const picker = ['Select permission mode', '❯ Always Ask', 'Ask When Needed', 'Never Ask ← current'];
  expect(kimiModeMenu(picker)).toEqual({ selected: 0, current: 2 });
  expect(kimiModeMenu(picker.slice(1))).toBeUndefined();
});

it('includes the native Other entry in its exact position without guessing unsupported choices', () => {
  const question = ['? Which marker?', '→ [1] Alpha', '[2] Beta', '[3] Other'];
  expect(kimiQuestionMenu(question, 'Which marker?', ['Alpha', 'Beta'])).toMatchObject({
    labels: ['Alpha', 'Beta', 'Other'], keys: ['1', '2', '3'],
  });
  expect(kimiQuestionMenu(question.toSpliced(3, 1, '[3] Unknown'), 'Which marker?', ['Alpha', 'Beta'])).toBeUndefined();
});

it('requires the working stock editor without a queue pane before steering', () => {
  const busy = screen.toSpliced(1, 0, ' ⠋ Working for 1s · fixture');
  expect(kimiComposer(busy, 'steer')).toEqual({ empty: true });
  expect(kimiComposer(busy.toSpliced(3, 1, ' │ > change direction │'), 'steer')).toEqual({ empty: false });
  expect(kimiComposer(screen, 'steer')).toBeUndefined();
  expect(kimiComposer(busy.toSpliced(2, 0, ' ─────────────', ' ❯ queued', ' ↑ to edit · ctrl-s to steer immediately'), 'steer')).toBeUndefined();
  expect(kimiComposer([...busy, '▶ 1. Approve once'], 'steer')).toBeUndefined();
  expect(kimiComposer(busy.toSpliced(1, 1, ' ⠋ Compacting context'), 'steer')).toBeUndefined();
});

it('recognizes a conclusive native queue pane without authorizing its bulk shortcut', () => {
  const base = screen.toSpliced(1, 0, ' ⠋ Working for 1s', ' ─────────────', ' ❯ queued', ' ↑ to edit · ctrl-s to steer immediately');
  expect(kimiComposer(base, 'selective-steer')).toEqual({ empty: true });
  expect(kimiComposer(base, 'steer')).toBeUndefined();
  expect(kimiComposer(base.toSpliced(3, 1, ' ❯ /compact'), 'selective-steer')).toBeUndefined();
  expect(kimiComposer(base.toSpliced(3, 1, ' ❯ Compact, then switch to a model'), 'selective-steer')).toBeUndefined();
  expect(kimiComposer(base.toSpliced(4, 1, ' 8 queued · ↑ to edit · ctrl-s to steer immediately'), 'selective-steer')).toBeUndefined();
  expect(kimiComposer([...base, 'Follow-up behavior'], 'selective-steer')).toBeUndefined();
  expect(kimiComposer(base.toSpliced(4, 1, ' ↑ to edit · will send after compaction'), 'selective-steer')).toBeUndefined();
});

it('detects the lazy startup capability independently of the displayed version', () => {
  const lazy = ['No session yet — one will be created on your first message.', ...screen];
  expect(kimiLazyStartup(lazy)).toBe(true);
  expect(kimiScreenVersion(lazy)).toBeUndefined();
  const version = ' │ Version: 9.1.0+future.build │';
  expect(kimiScreenVersion([version, ...lazy])).toBe('9.1.0+future.build');
  expect(kimiLazyStartup([version, ...screen])).toBe(false);
});
