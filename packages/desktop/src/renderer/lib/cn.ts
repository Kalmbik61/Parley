/**
 * Слияние классов Tailwind — стандартная утилита shadcn/ui (спека 4.5):
 * `clsx` собирает условные классы, `tailwind-merge` убирает конфликты одной
 * группы («px-2 px-4» → «px-4»), чего один `clsx` не умеет.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
