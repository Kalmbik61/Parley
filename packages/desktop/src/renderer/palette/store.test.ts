/**
 * Стор палитры ⌘J (кусок 6.2, спека 3.5): открыта ли палитра, режим и запрос — одно место.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRowPicker, usePaletteStore } from './store.js';

beforeEach(() => {
  usePaletteStore.setState({ open: false, mode: 'default', query: '' });
});

afterEach(() => {
  registerRowPicker(null);
});

describe('usePaletteStore', () => {
  it('openWith открывает в режиме с запросом; без запроса — пустой; close закрывает и чистит запрос', () => {
    usePaletteStore.getState().openWith('splitRight');
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'splitRight', query: '' });

    usePaletteStore.getState().setQuery('abc');
    usePaletteStore.getState().openWith('default', 'S02');
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'default', query: 'S02' });

    usePaletteStore.getState().close();
    expect(usePaletteStore.getState()).toMatchObject({ open: false, query: '' });
  });

  it('pickRow зовёт выбор строки открытой палитры; закрытая — ничего', () => {
    const picker = vi.fn();
    registerRowPicker(picker);

    usePaletteStore.getState().pickRow(1);
    expect(picker).not.toHaveBeenCalled();

    usePaletteStore.getState().openWith('default');
    usePaletteStore.getState().pickRow(1);
    expect(picker).toHaveBeenCalledWith(1);
  });
});
