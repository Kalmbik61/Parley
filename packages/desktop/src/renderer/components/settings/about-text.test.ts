import { describe, expect, it } from 'vitest';
import type { AboutInfo } from '../../../shared/bridge.js';
import { aboutText } from './about-text.js';

const INFO: AboutInfo = {
  version: '0.37.0',
  commit: '2b52d262',
  commitDate: '2026-11-17',
  dirty: false,
  arch: 'arm64',
  electron: '44.4.5',
  chrome: '140.0.1',
  node: '24.1.0',
  os: 'macOS 27.2',
  appPath: '/Applications/Parley.app',
  dataDir: '~/.parley',
  updateChecks: true,
  lastCheck: null,
};

describe('aboutText', () => {
  it('полная форма', () => {
    expect(aboutText(INFO, '0.37.0')).toBe(
      [
        'Parley 0.37.0 (arm64)',
        'Build 2b52d262, 2026-11-17',
        'Host 0.37.0',
        'Electron 44.4.5, Chromium 140.0.1, Node 24.1.0',
        'macOS 27.2',
        'App /Applications/Parley.app',
        'Data ~/.parley',
      ].join('\n'),
    );
  });

  it('version, commit, appPath и хост — null: строки опускаются', () => {
    const text = aboutText({ ...INFO, version: null, commit: null, commitDate: null, appPath: null }, null);
    expect(text).toBe(
      ['Parley (development build) (arm64)', 'Electron 44.4.5, Chromium 140.0.1, Node 24.1.0', 'macOS 27.2', 'Data ~/.parley'].join('\n'),
    );
  });

  it('dirty добавляет modified', () => {
    expect(aboutText({ ...INFO, dirty: true }, '0.37.0')).toContain('Build 2b52d262, 2026-11-17, modified');
  });
});
