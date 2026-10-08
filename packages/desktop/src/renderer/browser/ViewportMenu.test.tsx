// packages/desktop/src/renderer/browser/ViewportMenu.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { customSize, presetSpec, rotatedSpec, viewportName, ViewportMenu } from './ViewportMenu.js';

afterEach(cleanup);

function openMenu(): HTMLElement {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('помощники меню размеров (спека 4.2)', () => {
  it('presetSpec: DPR прежнего размера; из Fit — 2x у мобильных, 1x у прочих', () => {
    expect(presetSpec('mobile-m', null)).toEqual({ preset: 'mobile-m', rotated: false, dpr: 2 });
    expect(presetSpec('laptop', null)).toEqual({ preset: 'laptop', rotated: false, dpr: 1 });
    expect(presetSpec('tablet', { preset: 'mobile-s', rotated: true, dpr: 3 })).toEqual({ preset: 'tablet', rotated: false, dpr: 3 });
  });

  it('rotatedSpec: пресет — флаг, свой — ширина с высотой; за пределы — null', () => {
    expect(rotatedSpec({ preset: 'mobile-m', rotated: false, dpr: 2 })).toEqual({ preset: 'mobile-m', rotated: true, dpr: 2 });
    expect(rotatedSpec({ width: 1024, height: 700, mobile: false, dpr: 1 })).toEqual({ width: 700, height: 1024, mobile: false, dpr: 1 });
    expect(rotatedSpec({ width: 3000, height: 800, mobile: false, dpr: 1 })).toBeNull();
  });

  it('customSize: целые в 200–3840 × 200–2400; прочее — null', () => {
    expect(customSize('1024', ' 700 ')).toEqual({ width: 1024, height: 700 });
    const bad: Array<[string, string]> = [
      ['199', '700'],
      ['3841', '700'],
      ['1024', '2401'],
      ['10.5', '700'],
      ['', '700'],
      ['abc', '700'],
      ['1e3', '700'],
      ['0x400', '700'],
      ['+500', '700'],
      ['500.0', '700'],
    ];
    for (const [width, height] of bad) expect(customSize(width, height), `${width}×${height}`).toBeNull();
  });

  it('viewportName: Fit, имя пресета, W×H', () => {
    expect(viewportName(null)).toBe('Fit');
    expect(viewportName({ preset: 'mobile-m', rotated: true, dpr: 2 })).toBe('Mobile M');
    expect(viewportName({ width: 1024, height: 700, mobile: false, dpr: 1 })).toBe('1024×700');
  });
});

describe('ViewportMenu (спека 4.2)', () => {
  it('пункты: Fit, шесть пресетов с размерами, Custom…, Rotate, 1x 2x 3x; при Fit Rotate и DPR неактивны', () => {
    render(<ViewportMenu viewport={null} disabled={false} onChange={vi.fn()} />);
    const menu = openMenu();
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Fit',
      'Mobile S320×568',
      'Mobile M375×812',
      'Mobile L430×932',
      'Tablet768×1024',
      'Laptop1280×800',
      'Desktop1440×900',
      'Custom…',
      '1x',
      '2x',
      '3x',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Rotate' }).hasAttribute('data-disabled')).toBe(true);
    expect(within(menu).getByRole('menuitemradio', { name: '2x' }).hasAttribute('data-disabled')).toBe(true);
  });

  it('пресет из Fit — Mobile M 2x; Fit — null; подпись кнопки — имя размера', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ViewportMenu viewport={null} disabled={false} onChange={onChange} />);
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: /Mobile M/ }));
    expect(onChange).toHaveBeenLastCalledWith({ preset: 'mobile-m', rotated: false, dpr: 2 });
    rerender(<ViewportMenu viewport={{ preset: 'mobile-m', rotated: false, dpr: 2 }} disabled={false} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Viewport size' }).textContent).toBe('Mobile M');
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Fit' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('Rotate и DPR меняют текущий размер', () => {
    const onChange = vi.fn();
    const mobile: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };
    render(<ViewportMenu viewport={mobile} disabled={false} onChange={onChange} />);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Rotate' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...mobile, rotated: true });
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: '3x' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...mobile, dpr: 3 });
  });

  it('Custom…: поля W и H; вне пределов — подсказка и Apply неактивна; верный — свой размер', () => {
    const onChange = vi.fn();
    render(<ViewportMenu viewport={null} disabled={false} onChange={onChange} />);
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Custom…' }));
    const dialog = screen.getByRole('dialog');
    const width = within(dialog).getByRole('textbox', { name: 'Width' }) as HTMLInputElement;
    const height = within(dialog).getByRole('textbox', { name: 'Height' }) as HTMLInputElement;
    expect([width.value, height.value]).toEqual(['1280', '800']);
    fireEvent.change(width, { target: { value: '100' } });
    expect(within(dialog).getByRole('alert').textContent).toBe('Width 200–3840, height 200–2400');
    expect((within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(width, { target: { value: '1024' } });
    fireEvent.change(height, { target: { value: '700' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ width: 1024, height: 700, mobile: false, dpr: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('подсказка кнопки несёт текущий размер, имя для доступности не меняется', () => {
    const { rerender } = render(<ViewportMenu viewport={null} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Viewport size' }).getAttribute('title')).toBe('Fit');
    rerender(<ViewportMenu viewport={{ preset: 'mobile-m', rotated: false, dpr: 2 }} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Viewport size' }).getAttribute('title')).toBe('Mobile M');
    rerender(<ViewportMenu viewport={{ width: 1024, height: 700, mobile: false, dpr: 1 }} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Viewport size' }).getAttribute('title')).toBe('1024×700');
  });

  it('Custom…: после Escape и после Apply фокус возвращается на кнопку', async () => {
    render(<ViewportMenu viewport={null} disabled={false} onChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Viewport size' });

    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Custom…' }));
    fireEvent.keyDown(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Width' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));

    button.blur();
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Custom…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('Custom…: клик мимо поповера оставляет фокус там, куда кликнули', async () => {
    render(
      <>
        <input aria-label="Other" />
        <ViewportMenu viewport={null} disabled={false} onChange={vi.fn()} />
      </>,
    );
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Custom…' }));
    const dialog = screen.getByRole('dialog');
    await new Promise((resolve) => setTimeout(resolve, 10)); // Radix вешает слушатель клика мимо в следующем такте
    const other = screen.getByRole('textbox', { name: 'Other' });
    // Как у мыши: фокус уходит на нажатии, а поповер закрывается на клике.
    fireEvent.pointerDown(other);
    other.focus();
    fireEvent.click(other);
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(other);
  });

  it('без страницы — кнопка неактивна', () => {
    render(<ViewportMenu viewport={null} disabled onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Viewport size' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
