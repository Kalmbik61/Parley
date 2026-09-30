/**
 * Radix Select в jsdom (тесты диалогов 1.5, 1.7): список открывается по стрелке вниз на триггере, пункт выбирается
 * кликом. Списку нужны методы захвата указателя и `scrollIntoView`, которых в jsdom нет, — без них он падает при
 * открытии. `installRadixSelectPolyfills` зовут один раз на файл тестов, до первого рендера.
 */

import { fireEvent, screen } from '@testing-library/react';

export function installRadixSelectPolyfills(): void {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

/** Открывает список триггера и выбирает пункт по имени. */
export async function chooseOption(trigger: HTMLElement, name: string | RegExp): Promise<void> {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name }));
}
