import { describe, expect, it } from 'vitest';
import { GUIDE, GUIDE_TOPICS, guideTopic } from './guide.js';

/** Тексты тем без завершающего перевода строки — так они лежат в гиде между пустыми строками. */
const bodies = (): string[] => GUIDE_TOPICS.map((item) => (guideTopic(item.topic) ?? '').trimEnd());

describe('темы гида', () => {
  it('имя темы — латиница строчными, без повторов; у каждой есть строка «что внутри»', () => {
    const names = GUIDE_TOPICS.map((item) => item.topic);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^[a-z]+$/);
    expect(new Set(names).size).toBe(names.length);
    for (const item of GUIDE_TOPICS) expect(item.summary.trim(), item.topic).not.toBe('');
  });

  it('темы гида — комнаты, ведущий, участник, письма, worktree и окно среди них', () => {
    const names = GUIDE_TOPICS.map((item) => item.topic);

    for (const needed of ['rooms', 'lead', 'member', 'letters', 'worktrees', 'window']) {
      expect(names).toContain(needed);
    }
  });

  it('раздел темы не пуст и начинается своим заголовком', () => {
    for (const text of bodies()) expect(text).toMatch(/^#{2,3} \S/);
  });

  it('темы по порядку склеиваются в весь гид: ничего не потеряно и не задвоено', () => {
    const title = GUIDE.split('\n')[0];

    expect(`${title}\n\n${bodies().join('\n\n')}\n`).toBe(GUIDE);
  });

  it('тема с текстом заканчивается переводом строки, как и весь гид', () => {
    for (const item of GUIDE_TOPICS)
      expect(guideTopic(item.topic)?.endsWith('\n'), item.topic).toBe(true);
    expect(GUIDE.endsWith('\n')).toBe(true);
  });

  it('заголовки подтем: ведущий, участник и worktree — темы сами по себе, а не куски чужих', () => {
    expect(guideTopic('lead')).toMatch(/^### Ведущий и решение\n/);
    expect(guideTopic('member')).toMatch(/^### Участник комнаты\n/);
    expect(guideTopic('worktrees')).toMatch(/^### Worktree сессии\n/);
    // Комнаты — до ролей, окно — до worktree: роли и worktree не дублируются в родительских темах.
    expect(guideTopic('rooms')).not.toContain('### Ведущий и решение');
    expect(guideTopic('window')).not.toContain('### Worktree сессии');
  });

  it('указатель check_inbox лежит в теме про письма', () => {
    expect(guideTopic('letters')).toContain('## Указатель');
    expect(guideTopic('letters')).toContain('Новые письма (N). Вызови check_inbox.');
  });

  it('неизвестная тема — null; сверка точная, без учёта регистра не гадает', () => {
    expect(guideTopic('нет-такой')).toBeNull();
    expect(guideTopic('')).toBeNull();
    expect(guideTopic('Rooms')).toBeNull();
  });
});
