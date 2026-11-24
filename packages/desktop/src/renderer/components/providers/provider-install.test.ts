import { describe, expect, it } from 'vitest';
import { INSTALL_CONFIRM, installableId, manualUpdateCommand } from './provider-install.js';

describe('provider-install: opencode (spec 2026-11-12, 4.9)', () => {
  it('opencode is installable from the window; the confirmation shows the constant curl command and source', () => {
    expect(installableId('opencode')).toBe('opencode');
    expect(installableId('mystery')).toBeNull();
    expect(INSTALL_CONFIRM.opencode).toEqual({
      command: 'curl -fsSL https://opencode.ai/v2/install | bash',
      source: 'https://opencode.ai/v2/install',
      profile: true,
    });
  });

  it('manual update: an unknown or brew install shows the npm command; curl and npm installs update from Parley', () => {
    expect(manualUpdateCommand('opencode', 'unknown')).toBe('npm install -g @opencode/cli@latest');
    expect(manualUpdateCommand('opencode', 'brew')).toBe('npm install -g @opencode/cli@latest');
    expect(manualUpdateCommand('opencode', 'standalone')).toBeNull();
    expect(manualUpdateCommand('opencode', 'npm')).toBeNull();
    expect(manualUpdateCommand('qwen', 'brew')).toBe('brew upgrade qwen-code');
    expect(manualUpdateCommand('claude', 'unknown')).toBeNull();
  });
});
