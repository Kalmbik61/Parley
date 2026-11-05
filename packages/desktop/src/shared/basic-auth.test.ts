import { describe, expect, it } from 'vitest';
import { splitUrlCredentials } from './basic-auth.js';

describe('splitUrlCredentials', () => {
  it('отделяет user:pass и убирает их из адреса', () => {
    expect(splitUrlCredentials('https://admin:s3cret@stand.example.test/a?b=1#c')).toEqual({
      url: 'https://stand.example.test/a?b=1#c',
      credentials: { username: 'admin', password: 's3cret' },
    });
  });

  it('порт и loopback сохраняются', () => {
    expect(splitUrlCredentials('http://u:p@127.0.0.1:8080')).toEqual({
      url: 'http://127.0.0.1:8080/',
      credentials: { username: 'u', password: 'p' },
    });
  });

  it('декодирует процентное кодирование; пароль может быть пуст', () => {
    expect(splitUrlCredentials('http://me%40corp:p%3Aw%2F@h.test/').credentials).toEqual({ username: 'me@corp', password: 'p:w/' });
    expect(splitUrlCredentials('http://only@h.test/').credentials).toEqual({ username: 'only', password: '' });
  });

  it('битое %-кодирование не бросает', () => {
    expect(splitUrlCredentials('http://a%zz:b@h.test/').credentials).toEqual({ username: 'a%zz', password: 'b' });
  });

  it('без учётных данных адрес не меняется (даже без «/»)', () => {
    expect(splitUrlCredentials('http://localhost:5173')).toEqual({ url: 'http://localhost:5173', credentials: null });
  });

  it('не http(s) и не-адрес — как есть', () => {
    expect(splitUrlCredentials('ftp://u:p@h.test/')).toEqual({ url: 'ftp://u:p@h.test/', credentials: null });
    expect(splitUrlCredentials('not a url')).toEqual({ url: 'not a url', credentials: null });
  });
});
