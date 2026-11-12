/** Блок доставленных писем (спека 2026-11-12, 3.4): отправители, вид, комната, время, свёртка, пометка cut, остаток. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { FeedMail, FeedMailLetter } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { formatClock } from '../../lib/mail-view.js';
import { MailItem } from './MailItem.js';

afterEach(cleanup);

const AT = '2030-01-05T09:59:00.000Z';
const letter = (over: Partial<FeedMailLetter> = {}): FeedMailLetter => ({
  id: 'm-1', from: 's-03', fromLabel: 'backend', kind: 'note', room: null, at: AT, text: 'short', ...over,
});
const mail = (letters: FeedMailLetter[], over: Partial<FeedMail> = {}): FeedMail => ({
  id: 'mail:m-1', at: AT, kind: 'mail', via: 'check_inbox', toolUseId: 't', letters, ...over,
});
const show = (item: FeedMail) => render(<MailItem item={item} />);

describe('MailItem', () => {
  it('four sender types: a session, the human, the system and Parley', () => {
    show(mail([
      letter({ id: 'a' }),
      letter({ id: 'b', from: 'human', fromLabel: null }),
      letter({ id: 'c', from: 'system', fromLabel: 'system' }),
      letter({ id: 'd', from: 'parley', fromLabel: null }),
    ]));
    expect(screen.getAllByTestId('chat-mail-sender').map((node) => node.textContent)).toEqual([
      'S03 backend', S.chat.mail.you, S.participants.system, S.chat.mail.parley,
    ]);
    expect(S.chat.mail.you).toBe('you');
  });

  it('kind badge, room as "r-NN · title" and local time; a direct letter shows no room', () => {
    show(mail([
      letter({ id: 'a', kind: 'question', room: { id: 'r-28', title: 'Mail in chat' } }),
      letter({ id: 'b', kind: 'decision' }),
    ]));
    expect(screen.getAllByTestId('chat-mail-kind').map((node) => node.textContent)).toEqual(['question', 'decision']);
    expect(screen.getAllByTestId('chat-mail-room').map((node) => node.textContent)).toEqual(['r-28 · Mail in chat']);
    expect(screen.getAllByTestId('chat-mail-time')[0]?.textContent).toBe(formatClock(AT));
    expect(screen.getAllByTestId('chat-mail-time')[0]?.textContent).toMatch(/^\d\d:\d\d$/);
  });

  it('a letter of up to 6 lines is shown whole, without a toggle', () => {
    show(mail([letter({ text: Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n') })]));
    expect(screen.queryByTestId('chat-mail-toggle')).toBeNull();
    expect(screen.getByTestId('chat-mail-text').className).not.toContain('line-clamp');
  });

  it('a letter over 6 lines is folded, expanded by Show more and folded back by Show less', () => {
    show(mail([letter({ text: Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n') })]));
    const text = screen.getByTestId('chat-mail-text');
    expect(text.className).toContain('line-clamp-6');
    fireEvent.click(screen.getByText(S.chat.mail.showMore));
    expect(text.className).not.toContain('line-clamp');
    fireEvent.click(screen.getByText(S.chat.mail.showLess));
    expect(text.className).toContain('line-clamp-6');
    expect(screen.getByTestId('chat-mail-toggle').textContent).toBe(S.chat.mail.showMore);
  });

  it('a long single-line letter is folded too', () => {
    show(mail([letter({ text: 'x'.repeat(2000) })]));
    expect(screen.getByTestId('chat-mail-text').className).toContain('line-clamp-6');
  });

  it('the cut mark shows only for a cut letter', () => {
    show(mail([letter({ id: 'a', cut: true }), letter({ id: 'b' })]));
    const letters = screen.getAllByTestId('chat-mail-letter');
    expect(within(letters[0]!).getByTestId('chat-mail-cut').textContent).toBe(S.chat.mail.cut);
    expect(within(letters[1]!).queryByTestId('chat-mail-cut')).toBeNull();
  });

  it('the "N more unread" line shows when letters remain', () => {
    show(mail([letter()], { remaining: 3 }));
    expect(screen.getByTestId('chat-mail-remaining').textContent).toBe('3 more unread');
    cleanup();
    show(mail([letter()]));
    expect(screen.queryByTestId('chat-mail-remaining')).toBeNull();
  });
});
