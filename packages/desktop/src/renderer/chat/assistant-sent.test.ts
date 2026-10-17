import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { viaAssistantIds } from './assistant-sent.js';

const prompt = (id: string, text: string, at: string): FeedItem => ({ id, at, kind: 'prompt', text, images: 0 }) as FeedItem;

describe('viaAssistantIds — какие сообщения Chat отправил помощник', () => {
  const sent = [{ text: 'Тесты на Safari\nпропусти', at: '2026-10-15T10:00:00.000Z' }];
  it('совпали текст (без учёта пробелов) и время в пределах двух минут', () => {
    const ids = viaAssistantIds([prompt('a', 'Тесты на Safari пропусти', '2026-10-15T10:00:03.000Z')], sent);
    expect([...ids]).toEqual(['a']);
  });
  it('тот же текст позже двух минут — сам человек', () => {
    expect(viaAssistantIds([prompt('a', 'Тесты на Safari пропусти', '2026-10-15T10:05:00.000Z')], sent).size).toBe(0);
  });
  it('одна запись помечает одно сообщение', () => {
    const items = [prompt('a', 'Тесты на Safari пропусти', '2026-10-15T10:00:01.000Z'), prompt('b', 'Тесты на Safari пропусти', '2026-10-15T10:00:30.000Z')];
    expect([...viaAssistantIds(items, sent)]).toEqual(['a']);
  });
});
