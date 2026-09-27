import { describe, expect, it } from 'vitest';
import { dragHasFiles, pasteHasOnlyImage, pathsToInput, shellQuote } from './drop.js';

/** jsdom без DataTransfer: только те поля, что читает drop.ts. */
function transfer(items: Array<{ kind: string; type: string }>, types: string[] = []): DataTransfer {
  return { items, types } as unknown as DataTransfer;
}

describe('shellQuote и pathsToInput (тест 3)', () => {
  it("'a b' в одинарных кавычках", () => {
    expect(shellQuote('a b')).toBe("'a b'");
  });

  it("' внутри → '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('кириллица и $ остаются как есть внутри кавычек', () => {
    expect(shellQuote('/Users/я/$HOME.png')).toBe("'/Users/я/$HOME.png'");
  });

  it('два пути — через пробел, пробел в конце', () => {
    expect(pathsToInput(['/a b/x.txt', "/c/it's.png"])).toBe("'/a b/x.txt' '/c/it'\\''s.png' ");
  });
});

describe('pasteHasOnlyImage', () => {
  it('картинка без текста → true', () => {
    expect(pasteHasOnlyImage(transfer([{ kind: 'file', type: 'image/png' }]))).toBe(true);
  });

  it('картинка и текст → false: вставляется текст', () => {
    expect(
      pasteHasOnlyImage(
        transfer([
          { kind: 'string', type: 'text/plain' },
          { kind: 'file', type: 'image/png' },
        ]),
      ),
    ).toBe(false);
  });

  it('только текст или пусто → false', () => {
    expect(pasteHasOnlyImage(transfer([{ kind: 'string', type: 'text/plain' }]))).toBe(false);
    expect(pasteHasOnlyImage(transfer([]))).toBe(false);
  });

  it('файл не картинка → false', () => {
    expect(pasteHasOnlyImage(transfer([{ kind: 'file', type: 'application/pdf' }]))).toBe(false);
  });
});

describe('dragHasFiles', () => {
  it('Files в types → true, текст или ссылка → false', () => {
    expect(dragHasFiles(transfer([], ['Files']))).toBe(true);
    expect(dragHasFiles(transfer([], ['text/plain', 'text/uri-list']))).toBe(false);
  });
});
