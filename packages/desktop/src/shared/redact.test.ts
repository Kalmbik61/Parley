import { describe, expect, it } from 'vitest';
import { isSecretName, REDACTED, redactBody, redactHeaders, redactUrl, unmaskableJson } from './redact.js';
import { S } from './strings.js';

describe('isSecretName (спека браузера, раздел 6)', () => {
  it('заголовки входа и куки — всегда, в любом регистре', () => {
    for (const name of ['Authorization', 'proxy-authorization', 'Cookie', 'Set-Cookie']) expect(isSecretName(name), name).toBe(true);
  });

  it('token, secret, password, passwd, api-key/apikey/api_key, session, csrf, auth — частью имени', () => {
    for (const name of ['access_token', 'X-CSRF-Token', 'client_secret', 'userPassword', 'passwd', 'x-api-key', 'apiKey', 'API_KEY', 'sessionId', 'csrfmiddlewaretoken', 'X-Auth-User', 'oauth_state']) {
      expect(isSecretName(name), name).toBe(true);
    }
  });

  it('key — только отдельным словом, в том числе в camelCase; keyboard, monkey и keys — нет', () => {
    for (const name of ['key', 'private_key', 'privateKey', 'x-key-id']) expect(isSecretName(name), name).toBe(true);
    for (const name of ['keyboard', 'monkey', 'keys', 'content-type', 'accept', 'user', 'id']) expect(isSecretName(name), name).toBe(false);
  });
});

describe('redactHeaders', () => {
  it('значения секретных заголовков — <redacted>, имена и порядок те же, прочие — как есть', () => {
    expect(
      redactHeaders([
        ['Content-Type', 'application/json'],
        ['Authorization', 'Bearer abc'],
        ['Cookie', 'sid=1'],
        ['X-Request-Id', '42'],
      ]),
    ).toEqual([
      ['Content-Type', 'application/json'],
      ['Authorization', REDACTED],
      ['Cookie', REDACTED],
      ['X-Request-Id', '42'],
    ]);
  });
});

describe('redactUrl', () => {
  it('секретные параметры query — <redacted>, прочие и их кодировка — как были', () => {
    expect(redactUrl('http://localhost:5173/api/settings?token=abc&tab=general%20x&api_key=k')).toBe(
      `http://localhost:5173/api/settings?token=${REDACTED}&tab=general%20x&api_key=${REDACTED}`,
    );
  });

  it('user:pass@ убран; фрагмент с параметрами маскируется, простой якорь — нет', () => {
    expect(redactUrl('https://u:p@x.y/cb#access_token=t1&state=s')).toBe(`https://x.y/cb#access_token=${REDACTED}&state=s`);
    expect(redactUrl('https://x.y/docs#install')).toBe('https://x.y/docs#install');
  });

  it('без query и битый адрес — без падения', () => {
    expect(redactUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(redactUrl('not a url?password=1')).toBe(`not a url?password=${REDACTED}`);
  });
});

describe('redactBody', () => {
  it('вложенный JSON: секретные ключи на любой глубине и в массивах — <redacted>', () => {
    const body = JSON.stringify({ user: { name: 'demo', credentials: { password: 'p1' } }, items: [{ apiKey: 'k1' }, { id: 1 }], session_id: 's1' });
    expect(JSON.parse(redactBody(body, 'application/json; charset=utf-8'))).toEqual({
      user: { name: 'demo', credentials: { password: REDACTED } },
      items: [{ apiKey: REDACTED }, { id: 1 }],
      session_id: REDACTED,
    });
  });

  it('у секретного ключа объект или число — значение целиком <redacted>', () => {
    expect(JSON.parse(redactBody('{"auth":{"user":"a"},"pin":1,"token":42}', 'application/json'))).toEqual({ auth: REDACTED, pin: 1, token: REDACTED });
  });

  it('JSON узнаётся по типу или по первой скобке; битый и обрезанный — без изменений, его узнаёт unmaskableJson', () => {
    expect(JSON.parse(redactBody('[{"password":"x"}]', null))).toEqual([{ password: REDACTED }]);
    expect(JSON.parse(redactBody('{"token":"x"}', 'text/plain'))).toEqual({ token: REDACTED });
    const cut = '{"password": "p1", "note": "tr';
    // Маску на обрезанный JSON не наложить: значение у края могло быть отрезано посередине. Тело не отдаёт вызывающий.
    expect(redactBody(cut, 'application/json')).toBe(cut);
    expect(unmaskableJson(cut, 'application/json')).toBe(true);
    expect(unmaskableJson('{"a":1}', 'application/json')).toBe(false);
    expect(unmaskableJson('plain text', 'text/plain')).toBe(false);
    expect(unmaskableJson('', 'application/json')).toBe(false);
  });

  it('форма: секретные параметры — <redacted>', () => {
    expect(redactBody('user=demo&password=p1', 'application/x-www-form-urlencoded')).toBe(`user=demo&password=${REDACTED}`);
  });

  it('не-JSON тело не меняется, только режется по пределу с пометкой', () => {
    const text = 'password=p1 in plain text';
    expect(redactBody(text, 'text/plain')).toBe(text);
    expect(redactBody('x'.repeat(5000), 'text/plain', 4096)).toBe(`${'x'.repeat(4096)}${S.contextFile.truncated}`);
    expect(redactBody('x'.repeat(4096), 'text/plain', 4096)).toBe('x'.repeat(4096));
  });
});
