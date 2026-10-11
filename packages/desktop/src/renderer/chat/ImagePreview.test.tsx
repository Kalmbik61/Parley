/**
 * Просмотр картинки из результата инструмента (`ImagePreviewHost`): диалог один на вид «Chat» и живёт вне строк
 * виртуальной ленты — строку, которая его открыла, список может размонтировать, пока человек смотрит картинку
 * (агент работает дальше, лента прилипла к низу). Состояние у каждого вида своё: оно умирает вместе с ним, а другая
 * сессия или скрытая работа просмотр закрывают.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { ImagePreviewHost, useOpenImagePreview, type ImagePreviewTarget } from './ImagePreview.js';

const SMALL_A = 'data:image/png;base64,SMALLA';
const SMALL_B = 'data:image/png;base64,SMALLB';
const BIG_A = 'data:image/png;base64,BIGA';
const BIG_B = 'data:image/png;base64,BIGB';

const A: ImagePreviewTarget = { path: '/h/feed-images/a.png', label: 'Image 1 of 2', thumbnail: SMALL_A };
const B: ImagePreviewTarget = { path: '/h/feed-images/b.png', label: 'Image 2 of 2', thumbnail: SMALL_B };

function bridgeWithImages(): FakeBridge {
  const fake = createFakeBridge();
  fake.setThumbnail(A.path, BIG_A, 1600);
  fake.setThumbnail(B.path, BIG_B, 1600);
  return fake;
}

/** «Строка ленты»: кнопка, которая просит просмотр, как миниатюра `ToolImages`. */
function Opener({ target }: { target: ImagePreviewTarget }): JSX.Element {
  const open = useOpenImagePreview();
  return (
    <button type="button" onClick={(event) => open?.(target, event.currentTarget)}>
      {`open ${target.label}`}
    </button>
  );
}

function host(fake: FakeBridge, children: JSX.Element, props: { sessionKey?: string; visible?: boolean } = {}): JSX.Element {
  return (
    <ImagePreviewHost bridge={fake} sessionKey={props.sessionKey ?? 'k1'} visible={props.visible ?? true}>
      {children}
    </ImagePreviewHost>
  );
}

const openerA = (): HTMLElement => screen.getByRole('button', { name: 'open Image 1 of 2' });

/** Настоящий щелчок мышью: нажатие, отпускание и `click` (Radix закрывает по клику вне диалога, а не по одному нажатию). */
function mouseClick(target: Element): void {
  fireEvent.pointerDown(target);
  fireEvent.mouseDown(target);
  fireEvent.pointerUp(target);
  fireEvent.mouseUp(target);
  fireEvent.click(target);
}

afterEach(() => {
  cleanup();
});

describe('ImagePreviewHost — открытие и закрытие', () => {
  it('просьба открывает диалог с подписью картинки: сначала миниатюра, потом большая на 1600; Esc закрывает, фокус возвращается на кнопку', async () => {
    const fake = bridgeWithImages();
    render(host(fake, <Opener target={A} />));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(openerA());
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    const view = within(dialog).getByTestId('chat-tool-image-view');
    await waitFor(() => expect(view.getAttribute('src')).toBe(BIG_A));
    expect(view.getAttribute('alt')).toBe('Image 1 of 2');
    expect(fake.thumbnailRequests).toEqual([{ path: A.path, maxPx: 1600 }]);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(openerA());
  });

  it('крестик закрывает, следующая просьба открывает снова', async () => {
    const fake = bridgeWithImages();
    render(host(fake, <><Opener target={A} /><Opener target={B} /></>));
    fireEvent.click(openerA());
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'open Image 2 of 2' }));
    const second = await screen.findByRole('dialog', { name: 'Image 2 of 2' });
    await waitFor(() => expect(within(second).getByTestId('chat-tool-image-view').getAttribute('src')).toBe(BIG_B));
  });

  it('новая просьба при открытом диалоге (диалог не закрывался) — миниатюра новой картинки, а не большая версия прежней', async () => {
    const fake = bridgeWithImages();
    // Большая версия второй картинки в пути и не придёт: видно, что стоит в диалоге до её прихода.
    const original = fake.app.imageThumbnail;
    fake.app.imageThumbnail = (path, maxPx) => (path === B.path && maxPx === 1600 ? new Promise(() => undefined) : original(path, maxPx));
    let openPreview: ReturnType<typeof useOpenImagePreview> = null;
    function Probe(): null {
      openPreview = useOpenImagePreview();
      return null;
    }
    render(host(fake, <Probe />));

    act(() => openPreview?.(A, null));
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    await waitFor(() => expect(within(dialog).getByTestId('chat-tool-image-view').getAttribute('src')).toBe(BIG_A));

    act(() => openPreview?.(B, null));
    const view = within(screen.getByRole('dialog', { name: 'Image 2 of 2' })).getByTestId('chat-tool-image-view');
    expect(view.getAttribute('src')).toBe(SMALL_B);
  });

  it('клик вне диалога (по подложке) закрывает просмотр, фокус возвращается на кнопку', async () => {
    const fake = bridgeWithImages();
    render(host(fake, <Opener target={A} />));
    fireEvent.click(openerA());
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    // Radix вешает слушатель вне диалога чуть позже открытия — так же, как человек не кликает в тот же миг.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const scrim = document.querySelector('[data-state="open"].fixed.inset-0');
    expect(scrim).not.toBeNull();
    expect(dialog.contains(scrim)).toBe(false);

    mouseClick(scrim as Element);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(openerA());
  });

  it('клик по самой картинке просмотр не закрывает', async () => {
    const fake = bridgeWithImages();
    render(host(fake, <Opener target={A} />));
    fireEvent.click(openerA());
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    mouseClick(within(dialog).getByTestId('chat-tool-image-view'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole('dialog', { name: 'Image 1 of 2' })).toBe(dialog);
  });

  it('открытие и закрытие просмотра не перерисовывают строки: им отдана одна стабильная ссылка на просьбу', async () => {
    const fake = bridgeWithImages();
    let renders = 0;
    function Row(): JSX.Element {
      renders += 1;
      const open = useOpenImagePreview();
      return (
        <button type="button" onClick={(event) => open?.(A, event.currentTarget)}>
          row
        </button>
      );
    }
    render(host(fake, <Row />));
    expect(renders).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'row' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByTestId('chat-tool-image-view').getAttribute('src')).toBe(BIG_A));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(renders).toBe(1);
  });

  it('вне хоста useOpenImagePreview отдаёт null: просить некого', () => {
    let seen: unknown = 'unset';
    function Probe(): null {
      seen = useOpenImagePreview();
      return null;
    }
    render(<Probe />);
    expect(seen).toBeNull();
  });
});

describe('ImagePreviewHost — просмотр переживает строку ленты', () => {
  it('кнопка, открывшая просмотр, ушла из дерева (виртуальный список размонтировал строку) — тот же диалог открыт, картинка на месте', async () => {
    const fake = bridgeWithImages();
    const { rerender } = render(host(fake, <Opener target={A} />));
    fireEvent.click(openerA());
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });

    rerender(host(fake, <span>строки с картинкой больше нет</span>));
    expect(screen.queryByRole('button', { name: 'open Image 1 of 2' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Image 1 of 2' })).toBe(dialog);
    await waitFor(() => expect(within(dialog).getByTestId('chat-tool-image-view').getAttribute('src')).toBe(BIG_A));
    // Запрос большой версии не повторился из-за ухода строки.
    expect(fake.thumbnailRequests).toEqual([{ path: A.path, maxPx: 1600 }]);

    // Закрыли — фокусу вернуться некуда (кнопки нет), и это не падение.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  describe('фокус при закрытии, когда строки, открывшей просмотр, уже нет', () => {
    /** «Лента»: прокрутчик с меткой возврата фокуса; `withRow` — есть ли в нём строка с кнопкой. */
    function Scroller({ withRow, marked = true }: { withRow: boolean; marked?: boolean }): JSX.Element {
      return (
        <div data-testid="feed" tabIndex={-1} {...(marked ? { 'data-preview-return': '' } : {})}>
          {withRow ? <Opener target={A} /> : null}
        </div>
      );
    }

    it('строка ушла из дерева (виртуальный список) — фокус на прокрутчике ленты, а не на body', async () => {
      const fake = bridgeWithImages();
      const { rerender } = render(host(fake, <Scroller withRow />));
      fireEvent.click(openerA());
      const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
      rerender(host(fake, <Scroller withRow={false} />));

      fireEvent.keyDown(dialog, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(screen.getByTestId('feed'));
    });

    it('строка жива — фокус на ней, прокрутчик его не перехватывает', async () => {
      const fake = bridgeWithImages();
      render(host(fake, <Scroller withRow />));
      fireEvent.click(openerA());
      const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });

      fireEvent.keyDown(dialog, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(openerA());
    });

    it('прокрутчика нет или он помечен не там — фокус никуда не прыгает и ошибки нет', async () => {
      const fake = bridgeWithImages();
      const { rerender } = render(host(fake, <Scroller withRow marked={false} />));
      fireEvent.click(openerA());
      const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
      rerender(host(fake, <Scroller withRow={false} marked={false} />));

      fireEvent.keyDown(dialog, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(document.body);
    });

    it('прокрутчик сам ушёл из дерева (вид закрыт, пока диалог открыт) — закрытие проходит без ошибки', async () => {
      const fake = bridgeWithImages();
      const { rerender } = render(host(fake, <Scroller withRow />));
      fireEvent.click(openerA());
      const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
      rerender(host(fake, <span>вид без ленты</span>));

      fireEvent.keyDown(dialog, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(document.body);
    });
  });

  it('строка вернулась (прокрутили назад) — открытый просмотр остался один, второго не появилось', async () => {
    const fake = bridgeWithImages();
    const { rerender } = render(host(fake, <Opener target={A} />));
    fireEvent.click(openerA());
    await screen.findByRole('dialog');
    rerender(host(fake, <span>пусто</span>));
    rerender(host(fake, <Opener target={A} />));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

describe('ImagePreviewHost — другая сессия, скрытая работа, соседний вид', () => {
  it('другая сессия (`sessionKey`) — просмотр закрыт; вернулись к прежней — он сам не открывается', async () => {
    const fake = bridgeWithImages();
    const { rerender } = render(host(fake, <Opener target={A} />, { sessionKey: 'a' }));
    fireEvent.click(openerA());
    await screen.findByRole('dialog');

    rerender(host(fake, <Opener target={A} />, { sessionKey: 'b' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(host(fake, <Opener target={A} />, { sessionKey: 'a' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // И просьба, пришедшая уже из новой сессии, открывает просмотр как обычно.
    fireEvent.click(openerA());
    expect(await screen.findByRole('dialog', { name: 'Image 1 of 2' })).toBeTruthy();
  });

  it('работа скрыта (`visible` false: контейнеры работ LRU остаются смонтированными) — просмотр закрыт; снова видима — он сам не открывается', async () => {
    const fake = bridgeWithImages();
    const { rerender } = render(host(fake, <Opener target={A} />));
    fireEvent.click(openerA());
    await screen.findByRole('dialog');

    rerender(host(fake, <Opener target={A} />, { visible: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(host(fake, <Opener target={A} />, { visible: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('вид снят с экрана (размонтирован) — диалог уходит вместе с ним', async () => {
    const fake = bridgeWithImages();
    const view = render(host(fake, <Opener target={A} />));
    fireEvent.click(openerA());
    await screen.findByRole('dialog');
    view.unmount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('два вида в окне (разделённые группы): у каждого свой просмотр — просьба из одного открывает один диалог', async () => {
    const fake = bridgeWithImages();
    render(
      <>
        {host(fake, <Opener target={A} />, { sessionKey: 'one' })}
        {host(fake, <Opener target={B} />, { sessionKey: 'two' })}
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open Image 2 of 2' }));
    await screen.findByRole('dialog', { name: 'Image 2 of 2' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await act(async () => {});
    expect(fake.thumbnailRequests).toEqual([{ path: B.path, maxPx: 1600 }]);
  });
});
