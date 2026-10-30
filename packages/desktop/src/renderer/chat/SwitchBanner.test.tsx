import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { S } from '../../shared/strings.js';
import { useSwitchAgentStore } from '../store/switch-agent.js';
import { makeSession } from '../test-utils/work-fixtures.js';
import { SwitchBanner, switchBannerKind } from './SwitchBanner.js';

const REF = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const label = (id: string): string => (id === 'claude' ? 'Claude Code' : id);

afterEach(() => {
  cleanup();
  useSwitchAgentStore.setState({ ref: null });
});

describe('switchBannerKind', () => {
  it('провайдер удалён — removed; закрытая и autonomous — нет; идущая замена важнее', () => {
    expect(switchBannerKind(makeSession('s-01', 'S01'), true)).toBe('removed');
    expect(switchBannerKind(makeSession('s-01', 'S01'), false)).toBeNull();
    expect(switchBannerKind(makeSession('s-01', 'S01', { lifecycle: 'closed' }), true)).toBeNull();
    expect(switchBannerKind(makeSession('s-01', 'S01', { workspace: { kind: 'clone', path: '/x' } } as never), true)).toBeNull();
    expect(switchBannerKind(makeSession('s-01', 'S01', { switching: { id: 'a', to: 'codex', since: 'x' } }), true)).toBe('switching');
  });
});

describe('SwitchBanner', () => {
  it('удалённый провайдер: текст с id и кнопка, открывающая диалог', () => {
    render(<SwitchBanner session={makeSession('s-01', 'S01', { provider: 'gone' as never })} kind="removed" sessionRef={REF} label={label} />);
    expect(screen.getByTestId('chat-switch-banner').textContent).toContain('gone was removed from Parley');
    fireEvent.click(screen.getByText(S.chat.switchBanner.action));
    expect(useSwitchAgentStore.getState().ref).toEqual(REF);
  });
});
