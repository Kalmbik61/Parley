import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { focusComposer, setVisibilityCheck } from '../keys/type-to-focus.js';
import { Composer } from './Composer.js';

afterEach(() => {
  cleanup();
  setVisibilityCheck();
});

function mount() {
  return render(
    <Composer
      busy={false}
      visible={false}
      text=""
      onTextChange={vi.fn()}
      attachments={[]}
      onAttachmentsChange={vi.fn()}
      bridge={createFakeBridge()}
      onSubmit={vi.fn()}
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
