import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S } from '../../../shared/strings.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { chooseOption, installRadixSelectPolyfills } from '../../test-utils/radix-select.js';
import { useUiStore } from '../../store/ui.js';
import { AssistantSettings } from './AssistantSettings.js';

installRadixSelectPolyfills();

let bridge: FakeBridge;
const saved: unknown[] = [];
const text = S.assistant.settings;

beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  bridge.setHandler('providers.list', () => ({
    providers: [
      { id: 'claude', label: 'Claude Code', available: true, models: [{ id: 'haiku', label: 'Haiku' }] },
      { id: 'glm', label: 'GLM', available: true, models: null },
      { id: 'codex', label: 'Codex', available: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }] },
      { id: 'other', label: 'Offline one', available: false },
    ],
  }));
  saved.length = 0;
  useUiStore.setState({
    ui: { ...DEFAULT_UI },
    uiLoaded: true,
    patchUi: (patch) => {
      saved.push(patch);
      useUiStore.setState((state) => ({ ui: { ...state.ui, assistant: { ...state.ui.assistant, ...patch.assistant } } }));
    },
  });
});
afterEach(() => cleanup());

describe('AssistantSettings (спека 2026-10-14, 6.1)', () => {
  it('переключатель включает помощника через patchUi', () => {
    render(<AssistantSettings />);
    fireEvent.click(screen.getByRole('switch', { name: text.enabled }));
    expect(saved).toEqual([{ assistant: { enabled: true } }]);
  });

  it('в списке провайдеров только подключённые, первым — «First connected»', async () => {
    render(<AssistantSettings />);
    const trigger = screen.getByRole('combobox', { name: text.provider });
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(4));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([text.providerAuto, 'Claude Code', 'GLM', 'Codex']);
  });

  it('выбор провайдера сбрасывает модель', async () => {
    render(<AssistantSettings />);
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
    await chooseOption(screen.getByRole('combobox', { name: text.provider }), 'Codex');
    expect(saved).toEqual([{ assistant: { provider: 'codex', model: null } }]);
  });

  it('список моделей — из выбранного провайдера, первым «Fast default»', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, assistant: { ...DEFAULT_UI.assistant, provider: 'codex' } } });
    render(<AssistantSettings />);
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
    const trigger = screen.getByRole('combobox', { name: text.model });
    await waitFor(() => expect(trigger).toBeTruthy());
    // Список моделей наполняется после ответа providers.list: ждём пункт, а не только вызов.
    await waitFor(() => {
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([text.modelDefault, 'GPT-6 Luna']);
    });
  });

  it('язык: System, English и Russian пишут null, en и ru', () => {
    render(<AssistantSettings />);
    fireEvent.click(screen.getByRole('radio', { name: text.languageEnglish }));
    fireEvent.click(screen.getByRole('radio', { name: text.languageRussian }));
    fireEvent.click(screen.getByRole('radio', { name: text.languageSystem }));
    expect(saved).toEqual([{ assistant: { language: 'en' } }, { assistant: { language: 'ru' } }, { assistant: { language: null } }]);
  });

  it('сочетание занято — видна причина', async () => {
    bridge.app.assistantShortcut = async () => ({ accelerator: 'Alt+Space', ok: false });
    render(<AssistantSettings />);
    await waitFor(() => expect(screen.getByText(text.shortcutTaken)).toBeTruthy());
  });

  it('у GLM видна подсказка про 13 секунд', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, assistant: { ...DEFAULT_UI.assistant, provider: 'glm' } } });
    render(<AssistantSettings />);
    expect(screen.getByText(text.glmSlow)).toBeTruthy();
  });

  it('подсказка про Claude Desktop: Alt+Space и Option+Space видна, Ctrl+Shift+J нет', () => {
    const withHotkey = (hotkey: string): void =>
      useUiStore.setState({ ui: { ...DEFAULT_UI, assistant: { ...DEFAULT_UI.assistant, hotkey } } });
    withHotkey('alt + SPACE');
    const first = render(<AssistantSettings />);
    expect(screen.getByText(text.shortcutClaudeDesktop)).toBeTruthy();
    first.unmount();
    withHotkey('Option+Space');
    const second = render(<AssistantSettings />);
    expect(screen.getByText(text.shortcutClaudeDesktop)).toBeTruthy();
    second.unmount();
    withHotkey('Ctrl+Shift+J');
    render(<AssistantSettings />);
    expect(screen.queryByText(text.shortcutClaudeDesktop)).toBeNull();
  });
});
