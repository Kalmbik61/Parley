// packages/desktop/src/renderer/chat/ChatToolbar.test.tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatToolbar } from './ChatToolbar.js';

afterEach(cleanup);

describe('ChatToolbar — кнопка микрофона вида Terminal (спека 3.2)', () => {
  it('micTargetId — кнопка микрофона в тулбаре; без него — нет', () => {
    const { rerender } = render(<ChatToolbar workKey="k" tabId="t" view="terminal" available micTargetId="terminal:x" />);
    expect(screen.getByTestId('mic').dataset.target).toBe('terminal:x');
    rerender(<ChatToolbar workKey="k" tabId="t" view="terminal" available />);
    expect(screen.queryByTestId('mic')).toBeNull();
  });
});
