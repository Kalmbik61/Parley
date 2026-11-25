import { expect, it } from 'vitest';
import { kimiComposer, kimiModeMenu, kimiPermissionMenu, kimiQuestionMenu } from './native-screen.js';

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
  expect(kimiComposer(screen.toSpliced(2, 0, 'foo'))).toBeUndefined();
  expect(kimiComposer([...screen, '   ▶ 1. Approve once'])).toBeUndefined();
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
