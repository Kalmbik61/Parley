/**
 * Тест 2 куска 4.3 плана worktree: файлы и ханки отрисованы; бинарный файл —
 * строкой «двоичный файл».
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DiffView } from './DiffView.js';

afterEach(cleanup);

const TEXT_FILE_PATCH = `diff --git a/foo.txt b/foo.txt
index e69de29..4b825dc 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1 +1,2 @@
-старая строка
+новая строка
+ещё строка
`;

const BINARY_FILE_PATCH = `diff --git a/image.png b/image.png
index 1234567..89abcde 100644
Binary files a/image.png and b/image.png differ
`;

describe('DiffView', () => {
  it('пустой патч — «изменений нет»', () => {
    render(<DiffView patch="" />);
    expect(screen.getByText('No changes')).toBeTruthy();
  });

  it('текстовый файл: путь и строки ханка отрисованы', () => {
    render(<DiffView patch={TEXT_FILE_PATCH} />);
    expect(screen.getByText('foo.txt')).toBeTruthy();
    expect(screen.getByText('новая строка')).toBeTruthy();
    expect(screen.getByText('старая строка')).toBeTruthy();
  });

  it('бинарный файл — строка «двоичный файл» вместо ханков', () => {
    render(<DiffView patch={BINARY_FILE_PATCH} />);
    expect(screen.getByText('image.png')).toBeTruthy();
    expect(screen.getByText('Binary file')).toBeTruthy();
  });
});
