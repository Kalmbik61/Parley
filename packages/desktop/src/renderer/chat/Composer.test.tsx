import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { focusComposer, setVisibilityCheck } from '../keys/type-to-focus.js';
import { useDictationStore } from '../voice/dictation-store.js';
import { Composer } from './Composer.js';

afterEach(() => {
  cleanup();
  setVisibilityCheck();
  vi.restoreAllMocks();
  useDictationStore.setState({ phase: 'idle', targetId: null });
});

function mount(text = '', onSubmit = vi.fn()) {
  return render(
    <Composer
      busy={false}
      visible={false}
      text={text}
      onTextChange={vi.fn()}
      attachments={[]}
      onAttachmentsChange={vi.fn()}
      bridge={createFakeBridge()}
      onSubmit={onSubmit}
      source={{ capabilities: null, listDir: () => Promise.resolve([]) }}
      onPickFiles={() => Promise.resolve([])}
      onPasteImage={() => Promise.resolve(null)}
      dictationId="chat:test"
    />,
  );
}

describe('Composer чата — набор с любого места', () => {
  it('смонтированное поле регистрируется и получает фокус, после размонтирования — нет', () => {
    setVisibilityCheck(() => true);
    const view = mount();
    expect(focusComposer()).toBe(true);
    expect(document.activeElement).toBe(view.container.querySelector('textarea'));

    view.unmount();
    expect(focusComposer()).toBe(false);
  });
});

describe('Composer чата — Enter/Send во время диктовки', () => {
  it('диктовка идёт: Enter завершает её и не отправляет', () => {
    const finish = vi.spyOn(useDictationStore.getState(), 'finishBeforeSend').mockReturnValue(true);
    const onSubmit = vi.fn();
    mount('набранное', onSubmit);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(finish).toHaveBeenCalledWith('chat:test');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('диктовки нет: Enter отправляет как раньше', () => {
    const finish = vi.spyOn(useDictationStore.getState(), 'finishBeforeSend').mockReturnValue(false);
    const onSubmit = vi.fn();
    mount('набранное', onSubmit);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(finish).toHaveBeenCalledWith('chat:test');
    expect(onSubmit).toHaveBeenCalledWith('набранное', []);
  });

  it('запись в это поле при пустом тексте: Send доступен, нажатие не отправляет; без записи — недоступен', () => {
    const finish = vi.spyOn(useDictationStore.getState(), 'finishBeforeSend').mockReturnValue(true);
    const onSubmit = vi.fn();
    mount('', onSubmit);
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    act(() => useDictationStore.setState({ phase: 'recording', targetId: 'chat:test' }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(finish).toHaveBeenCalledWith('chat:test');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
