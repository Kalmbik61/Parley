/**
 * Картинки из результата инструмента под вызовом (`ToolImages`): ряд миниатюр 160×120 по ссылкам
 * `response.images`, просмотр в диалоге на 1600 px, значок вместо картинки, которую не прочесть.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FeedImageRef } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { ChatEnvContext } from '../chat-env.js';
import { ImagePreviewHost } from '../ImagePreview.js';
import { resetThumbnailCacheForTests } from '../use-thumbnail.js';
import { ToolImages } from './ToolImages.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const SMALL_A = 'data:image/png;base64,SMALLA';
const SMALL_B = 'data:image/png;base64,SMALLB';
const BIG_A = 'data:image/png;base64,BIGA';
const BIG_B = 'data:image/png;base64,BIGB';

const A = '/home/u/.parley/feed-images/aaaa.png';
const B = '/home/u/.parley/feed-images/bbbb.jpg';
const images: FeedImageRef[] = [
  { path: A, mime: 'image/png', bytes: 120_000 },
  { path: B, mime: 'image/jpeg' },
];

/** Ряд в окружении ленты и с диалогом просмотра, который в окне держит `ChatView` (`ImagePreviewHost`). */
function renderImages(list: readonly FeedImageRef[] = images, fake: FakeBridge = createFakeBridge()): FakeBridge {
  render(
    <ChatEnvContext.Provider value={{ bridge: fake, sessionRef: REF }}>
      <ImagePreviewHost bridge={fake} sessionKey="k1" visible>
        <ToolImages images={list} />
      </ImagePreviewHost>
    </ChatEnvContext.Provider>,
  );
  return fake;
}

/** Мост с миниатюрами обеих картинок и их большими версиями. */
function bridgeWithImages(): FakeBridge {
  const fake = createFakeBridge();
  fake.setThumbnail(A, SMALL_A);
  fake.setThumbnail(B, SMALL_B);
  fake.setThumbnail(A, BIG_A, 1600);
  fake.setThumbnail(B, BIG_B, 1600);
  return fake;
}

/**
 * Ответ моста, который держит запрос: `app.imageThumbnail` отдаёт обещание, пока тест не позовёт `release`.
 * `only` — какие запросы держать (по стороне; `undefined` — миниатюры без стороны), остальные идут к мосту как есть.
 */
function holdRequests(fake: FakeBridge, only: (maxPx: number | undefined) => boolean): { release: (url: string | null) => void } {
  const original = fake.app.imageThumbnail;
  const waiting: Array<(url: string | null) => void> = [];
  fake.app.imageThumbnail = (path, maxPx) => {
    if (!only(maxPx)) return original(path, maxPx);
    return new Promise<string | null>((resolve) => waiting.push(resolve));
  };
  return { release: (url) => waiting.splice(0).forEach((resolve) => resolve(url)) };
}

beforeEach(() => {
  resetThumbnailCacheForTests();
});

afterEach(() => {
  cleanup();
});

describe('ToolImages — ряд миниатюр', () => {
  it('две ссылки — две кнопки «Image 1 of 2» и «Image 2 of 2» с миниатюрами из моста; миниатюры просятся без стороны (по умолчанию 320)', async () => {
    const fake = bridgeWithImages();
    renderImages(images, fake);
    await act(async () => {});
    const buttons = screen.getAllByTestId('chat-tool-image');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Image 1 of 2', 'Image 2 of 2']);
    expect(screen.getByRole('button', { name: 'Image 2 of 2' })).toBe(buttons[1]);
    expect(buttons.map((button) => button.querySelector('img')?.getAttribute('src'))).toEqual([SMALL_A, SMALL_B]);
    expect(buttons.map((button) => button.getAttribute('title'))).toEqual(['Open image', 'Open image']);
    // Кнопка открывает диалог: об этом знает скринридер.
    expect(buttons.map((button) => button.getAttribute('aria-haspopup'))).toEqual(['dialog', 'dialog']);
    expect(fake.thumbnailRequests).toEqual([
      { path: A, maxPx: undefined },
      { path: B, maxPx: undefined },
    ]);
  });

  it('кнопка 160×120 и не сжимается, ряд переносится: в окне 800×500 горизонтальной прокрутки нет', async () => {
    renderImages(images, bridgeWithImages());
    await act(async () => {});
    const row = screen.getByTestId('chat-tool-images');
    expect(row.className).toContain('flex-wrap');
    for (const button of screen.getAllByTestId('chat-tool-image')) {
      expect(button.className).toContain('h-[120px] w-[160px]');
      expect(button.className).toContain('shrink-0');
    }
  });

  it('миниатюра показывает картинку целиком: object-contain на нейтральной подложке, а не object-cover (скриншот не обрезается)', async () => {
    renderImages(images, bridgeWithImages());
    await act(async () => {});
    for (const button of screen.getAllByTestId('chat-tool-image')) {
      const picture = button.querySelector('img');
      expect(picture?.className).toContain('object-contain');
      expect(picture?.className).not.toContain('object-cover');
      expect(button.className).toContain('bg-muted');
    }
  });

  it('и там, где просмотра нет (ряд вне ChatView), миниатюра тоже целиком', async () => {
    const fake = bridgeWithImages();
    render(
      <ChatEnvContext.Provider value={{ bridge: fake, sessionRef: REF }}>
        <ToolImages images={images} />
      </ChatEnvContext.Provider>,
    );
    await act(async () => {});
    for (const frame of screen.getAllByTestId('chat-tool-image-static')) {
      expect(frame.querySelector('img')?.className).toContain('object-contain');
      expect(frame.querySelector('img')?.className).not.toContain('object-cover');
      expect(frame.className).toContain('bg-muted');
    }
  });

  it('одна картинка — «Image 1 of 1»; шесть — шесть кнопок по порядку', async () => {
    const fake = createFakeBridge();
    const six = Array.from({ length: 6 }, (_, at): FeedImageRef => ({ path: `/h/feed-images/${at}.png`, mime: 'image/png' }));
    for (const ref of six) fake.setThumbnail(ref.path, `data:image/png;base64,${ref.path}`);
    renderImages(six.slice(0, 1), fake);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Image 1 of 1' })).toBeTruthy();
    cleanup();
    resetThumbnailCacheForTests();
    renderImages(six, fake);
    await act(async () => {});
    expect(screen.getAllByTestId('chat-tool-image').map((button) => button.getAttribute('aria-label'))).toEqual(
      six.map((_, at) => `Image ${at + 1} of 6`),
    );
  });

  it('повтор той же картинки (хост кладёт одинаковые байты в один файл) — две кнопки, один запрос миниатюры и ключи без повторов', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = bridgeWithImages();
    renderImages([images[0]!, images[0]!], fake);
    await act(async () => {});
    expect(screen.getAllByTestId('chat-tool-image')).toHaveLength(2);
    expect(fake.thumbnailRequests).toEqual([{ path: A, maxPx: undefined }]);
    // Одинаковый путь у двух ссылок не должен давать одинаковый ключ: React ругается в консоль и путает строки при обновлении.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('пока миниатюра в пути — рамка того же размера без подписи «unavailable» (ряд не прыгает), потом картинка', async () => {
    const fake = bridgeWithImages();
    const held = holdRequests(fake, (maxPx) => maxPx === undefined);
    renderImages(images, fake);
    await act(async () => {});
    expect(screen.queryByTestId('chat-tool-image')).toBeNull();
    expect(screen.queryByText('Image unavailable')).toBeNull();
    const placeholders = screen.getAllByTestId('chat-tool-image-pending');
    expect(placeholders).toHaveLength(2);
    for (const frame of placeholders) expect(frame.className).toContain('h-[120px] w-[160px]');
    await act(async () => held.release(SMALL_A));
    expect(screen.queryByTestId('chat-tool-image-pending')).toBeNull();
    expect(screen.getAllByTestId('chat-tool-image')).toHaveLength(2);
  });
});

describe('ToolImages — картинку не прочесть', () => {
  it('миниатюры нет (ответ null) — значок и «Image unavailable», кнопки нет; путь — в подсказке', async () => {
    renderImages(images, createFakeBridge());
    await act(async () => {});
    expect(screen.queryByTestId('chat-tool-image')).toBeNull();
    expect(screen.queryByTestId('chat-tool-image-pending')).toBeNull();
    const chips = screen.getAllByTestId('chat-tool-image-unavailable');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Image unavailable', 'Image unavailable']);
    expect(chips.map((chip) => chip.getAttribute('title'))).toEqual([A, B]);
    expect(chips[0]!.querySelector('svg')?.getAttribute('class')).toContain('lucide-image');
  });

  it('сбой IPC — то же, что «миниатюры нет»: лента живёт', async () => {
    const fake = createFakeBridge();
    fake.app.imageThumbnail = () => Promise.reject(new Error('ipc'));
    renderImages(images, fake);
    await act(async () => {});
    expect(screen.getAllByText('Image unavailable')).toHaveLength(2);
  });

  it('одна из двух не читается — вторая миниатюра на месте, порядок и подписи прежние', async () => {
    const fake = createFakeBridge();
    fake.setThumbnail(B, SMALL_B);
    renderImages(images, fake);
    await act(async () => {});
    expect(screen.getByTestId('chat-tool-image-unavailable').getAttribute('title')).toBe(A);
    expect(screen.getByRole('button', { name: 'Image 2 of 2' }).querySelector('img')?.getAttribute('src')).toBe(SMALL_B);
    expect(screen.getByTestId('chat-tool-images').children).toHaveLength(2);
  });

  it('вне окружения ленты (моста нет) — значки без исключения и без ожидания', () => {
    render(<ToolImages images={images} />);
    expect(screen.getAllByText('Image unavailable')).toHaveLength(2);
    expect(screen.queryByTestId('chat-tool-image')).toBeNull();
    expect(screen.queryByTestId('chat-tool-image-pending')).toBeNull();
  });

  it('мост есть, а диалога просмотра нет (ряд вне `ChatView`) — миниатюры на месте, но не кнопки: нажимать некуда', async () => {
    const fake = bridgeWithImages();
    render(
      <ChatEnvContext.Provider value={{ bridge: fake, sessionRef: REF }}>
        <ToolImages images={images} />
      </ChatEnvContext.Provider>,
    );
    await act(async () => {});
    expect(screen.queryByTestId('chat-tool-image')).toBeNull();
    const frames = screen.getAllByTestId('chat-tool-image-static');
    expect(frames.map((frame) => frame.querySelector('img')?.getAttribute('src'))).toEqual([SMALL_A, SMALL_B]);
    for (const frame of frames) expect(frame.className).toContain('h-[120px] w-[160px]');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ToolImages — просмотр', () => {
  it('клик — диалог с картинкой: сначала миниатюра, пока идёт запрос на 1600, потом большая; Esc закрывает, фокус возвращается на кнопку', async () => {
    const fake = bridgeWithImages();
    const held = holdRequests(fake, (maxPx) => maxPx === 1600);
    const sizes: Array<number | undefined> = [];
    const heldRequest = fake.app.imageThumbnail;
    fake.app.imageThumbnail = (path, maxPx) => {
      sizes.push(maxPx);
      return heldRequest(path, maxPx);
    };
    renderImages(images, fake);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();

    const button = screen.getByRole('button', { name: 'Image 1 of 2' });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    const view = within(dialog).getByTestId('chat-tool-image-view');
    expect(view.tagName).toBe('IMG');
    expect(view.getAttribute('alt')).toBe('Image 1 of 2');
    expect(view.getAttribute('src')).toBe(SMALL_A);
    expect(sizes).toEqual([undefined, undefined, 1600]);

    await act(async () => held.release(BIG_A));
    expect(view.getAttribute('src')).toBe(BIG_A);
    // Картинка вписана в рамку диалога целиком (рамка от окна, а не от картинки): пропорции целы, диалог не прыгает.
    for (const cls of ['size-full', 'object-contain']) expect(view.className).toContain(cls);
    expect(view.className).not.toContain('max-h-[85vh]');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('просмотр просит у моста ровно 1600 и ровно ту картинку, на которую нажали; вторая кнопка — своя картинка', async () => {
    const fake = bridgeWithImages();
    renderImages(images, fake);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Image 2 of 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Image 2 of 2' });
    await waitFor(() => expect(within(dialog).getByTestId('chat-tool-image-view').getAttribute('src')).toBe(BIG_B));
    expect(fake.thumbnailRequests.filter((request) => request.maxPx !== undefined)).toEqual([{ path: B, maxPx: 1600 }]);
  });

  it('диалог открывается сразу своего размера — от окна, а не от картинки: миниатюра в пути не даёт скачка; с заголовком для скринридера', async () => {
    renderImages(images, bridgeWithImages());
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Image 1 of 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    // Рамка — доли окна с первого кадра, предел — размер большой версии и поля у края окна; `w-fit` оставил бы
    // рамку по размеру миниатюры, а `max-w-lg` базового диалога сузил бы её до 512 px.
    for (const cls of ['w-[90vw]', 'h-[85vh]', 'max-w-[min(1640px,calc(100vw-2rem))]', 'max-h-[min(1240px,calc(100dvh-2rem))]']) {
      expect(dialog.className).toContain(cls);
    }
    expect(dialog.className).not.toContain('w-fit');
    expect(dialog.className).not.toContain('max-w-lg');
    expect(within(dialog).getByText('Image 1 of 2').className).toContain('sr-only');
    // Крестик диалога лежит поверх угла картинки: без подложки на светлом или тёмном скриншоте его не видно.
    expect(dialog.className).toContain('[&>button]:bg-background/85');
    expect(dialog.className).toContain('[&>button]:opacity-100');
  });

  it('миниатюра и большая версия стоят в одной рамке с одними классами: приход большой версии размеров не меняет', async () => {
    const fake = bridgeWithImages();
    const held = holdRequests(fake, (maxPx) => maxPx === 1600);
    renderImages(images, fake);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Image 1 of 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Image 1 of 2' });
    const view = within(dialog).getByTestId('chat-tool-image-view');
    expect(view.getAttribute('src')).toBe(SMALL_A);
    const placeholder = { className: view.className, frame: view.parentElement?.className, dialog: dialog.className };

    await act(async () => held.release(BIG_A));
    expect(view.getAttribute('src')).toBe(BIG_A);
    expect({ className: view.className, frame: view.parentElement?.className, dialog: dialog.className }).toEqual(placeholder);
  });

  it('большая версия не пришла (null или сбой IPC) — в диалоге остаётся миниатюра', async () => {
    const empty = bridgeWithImages();
    empty.setThumbnail(A, null, 1600);
    renderImages(images, empty);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Image 1 of 2' }));
    let view = (await screen.findByTestId('chat-tool-image-view')) as HTMLImageElement;
    await act(async () => {});
    expect(view.getAttribute('src')).toBe(SMALL_A);
    expect(empty.thumbnailRequests).toContainEqual({ path: A, maxPx: 1600 });
    cleanup();
    resetThumbnailCacheForTests();

    const broken = bridgeWithImages();
    const original = broken.app.imageThumbnail;
    broken.app.imageThumbnail = (path, maxPx) => (maxPx === 1600 ? Promise.reject(new Error('ipc')) : original(path, maxPx));
    renderImages(images, broken);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Image 1 of 2' }));
    view = (await screen.findByTestId('chat-tool-image-view')) as HTMLImageElement;
    await act(async () => {});
    expect(view.getAttribute('src')).toBe(SMALL_A);
  });

  it('закрыли до ответа — позднее обещание ничего не ломает; повторное открытие просит заново', async () => {
    const fake = bridgeWithImages();
    const held = holdRequests(fake, (maxPx) => maxPx === 1600);
    renderImages(images, fake);
    await act(async () => {});
    const button = screen.getByRole('button', { name: 'Image 1 of 2' });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => held.release(BIG_A));
    expect(screen.queryByTestId('chat-tool-image-view')).toBeNull();

    fireEvent.click(button);
    await screen.findByRole('dialog');
    await act(async () => held.release(BIG_A));
    expect(screen.getByTestId('chat-tool-image-view').getAttribute('src')).toBe(BIG_A);
  });
});
