import { describe, expect, it } from 'vitest';
import { testSwitches } from './test-switches.js';

const ALL_ON = {
  PARLEY_DOWNLOADS: 'log',
  PARLEY_DIALOGS: 'log',
  PARLEY_NOTIFICATIONS: 'log',
  PARLEY_DROPS: 'fake',
  PARLEY_SHELL: 'log',
  PARLEY_LOGIN_SHELL: 'skip',
};

describe('testSwitches', () => {
  it('неупакованное окно (E2E, pnpm dev) слушает все шесть переключателей', () => {
    expect(testSwitches(ALL_ON, false)).toEqual({
      downloads: true,
      dialogs: true,
      notifications: true,
      drops: true,
      shell: true,
      loginShell: true,
    });
  });

  it('собранное приложение их не слушает: уведомления, ссылки и загрузки не глохнут молча', () => {
    expect(testSwitches(ALL_ON, true)).toEqual({
      downloads: false,
      dialogs: false,
      notifications: false,
      drops: false,
      shell: false,
      loginShell: false,
    });
  });

  it('собранное приложение с явным PARLEY_E2E=1 слушает их — для проверок сборки', () => {
    expect(testSwitches({ ...ALL_ON, PARLEY_E2E: '1' }, true)).toEqual({
      downloads: true,
      dialogs: true,
      notifications: true,
      drops: true,
      shell: true,
      loginShell: true,
    });
  });

  it('PARLEY_E2E с другим значением не открывает переключатели в сборке', () => {
    expect(testSwitches({ ...ALL_ON, PARLEY_E2E: 'true' }, true).notifications).toBe(false);
  });

  it('прежние имена HARNAS_* читаются как запасные (R3); новое главнее, пустое новое прежнее не перекрывает', () => {
    const legacy = {
      HARNAS_DOWNLOADS: 'log',
      HARNAS_DIALOGS: 'log',
      HARNAS_NOTIFICATIONS: 'log',
      HARNAS_DROPS: 'fake',
      HARNAS_SHELL: 'log',
      HARNAS_LOGIN_SHELL: 'skip',
    };
    const all = { downloads: true, dialogs: true, notifications: true, drops: true, shell: true, loginShell: true };
    expect(testSwitches(legacy, false)).toEqual(all);
    // В собранном приложении — только с явным HARNAS_E2E=1, как и с PARLEY_E2E=1.
    expect(testSwitches(legacy, true).notifications).toBe(false);
    expect(testSwitches({ ...legacy, HARNAS_E2E: '1' }, true)).toEqual(all);
    // Новое имя главнее: PARLEY_NOTIFICATIONS=off гасит переключатель, хотя прежнее просит журнал.
    expect(testSwitches({ ...legacy, PARLEY_NOTIFICATIONS: 'off' }, false).notifications).toBe(false);
    expect(testSwitches({ ...legacy, PARLEY_NOTIFICATIONS: '' }, false).notifications).toBe(true);
  });

  it('без переменных и в неупакованном окне всё выключено; значение должно совпасть точно', () => {
    expect(testSwitches({}, false)).toEqual({
      downloads: false,
      dialogs: false,
      notifications: false,
      drops: false,
      shell: false,
      loginShell: false,
    });
    expect(testSwitches({ PARLEY_DROPS: 'log', PARLEY_SHELL: '1', PARLEY_LOGIN_SHELL: '1' }, false)).toMatchObject({
      drops: false,
      shell: false,
      loginShell: false,
    });
  });
});
