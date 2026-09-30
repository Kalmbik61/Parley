import { describe, expect, it } from 'vitest';
import { testSwitches } from './test-switches.js';

const ALL_ON = {
  HARNAS_DOWNLOADS: 'log',
  HARNAS_DIALOGS: 'log',
  HARNAS_NOTIFICATIONS: 'log',
  HARNAS_DROPS: 'fake',
  HARNAS_SHELL: 'log',
  HARNAS_LOGIN_SHELL: 'skip',
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

  it('собранное приложение с явным HARNAS_E2E=1 слушает их — для проверок сборки', () => {
    expect(testSwitches({ ...ALL_ON, HARNAS_E2E: '1' }, true)).toEqual({
      downloads: true,
      dialogs: true,
      notifications: true,
      drops: true,
      shell: true,
      loginShell: true,
    });
  });

  it('HARNAS_E2E с другим значением не открывает переключатели в сборке', () => {
    expect(testSwitches({ ...ALL_ON, HARNAS_E2E: 'true' }, true).notifications).toBe(false);
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
    expect(testSwitches({ HARNAS_DROPS: 'log', HARNAS_SHELL: '1', HARNAS_LOGIN_SHELL: '1' }, false)).toMatchObject({
      drops: false,
      shell: false,
      loginShell: false,
    });
  });
});
