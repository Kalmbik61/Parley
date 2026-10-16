import { describe, expect, it } from 'vitest';
import { isSecretName, REDACTED, redactBody, redactHeaders, redactSecretsInText, redactUrl, redactUrlsInText, unmaskableJson } from './redact.js';
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

  it('Referer, Location и Content-Location — адреса: секреты query и фрагмента — <redacted>, регистр имени не важен, Origin и прочие — как есть', () => {
    // Страница /reset?token=… кладёт свой адрес в Referer каждого запроса, редирект OAuth — токен во фрагмент Location.
    expect(
      redactHeaders([
        ['Referer', 'http://localhost:5173/reset?token=abc&tab=x'],
        ['location', 'https://x.y/cb#access_token=t1&state=s'],
        ['Content-Location', '/v2/doc?api_key=k&lang=en'],
        ['Origin', 'http://localhost:5173'],
        ['Host', 'localhost:5173'],
      ]),
    ).toEqual([
      ['Referer', `http://localhost:5173/reset?token=${REDACTED}&tab=x`],
      ['location', `https://x.y/cb#access_token=${REDACTED}&state=s`],
      ['Content-Location', `/v2/doc?api_key=${REDACTED}&lang=en`],
      ['Origin', 'http://localhost:5173'],
      ['Host', 'localhost:5173'],
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

  it('пароль с «@» в адресе: убрано всё до последней «@» входа, хвост пароля не остаётся; «@» после пути не трогается', () => {
    // Браузер делит адрес входа по последней «@», поэтому в `user:p@ss@host` пароль — `p@ss`.
    expect(redactUrl('https://user:p@ss@host.example/path?x=1')).toBe('https://host.example/path?x=1');
    expect(redactUrl('https://user:pa%40ss@host.example/path')).toBe('https://host.example/path');
    expect(redactUrl('https://host.example/mail/a@b.c')).toBe('https://host.example/mail/a@b.c');
  });
});

// Точный текст Log.entryAdded из Electron 44.4.5: fetch на другой origin без заголовков CORS. Chromium цитирует адрес запроса целиком.
const CORS_MESSAGE =
  "Access to fetch at 'http://127.0.0.1:62482/api/x?token=SECRET-QUERY-123&tab=1' from origin 'http://127.0.0.1:62483' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.";

describe('redactUrlsInText', () => {
  it('сообщение CORS цитирует адрес запроса с ?token= — адрес идёт через redactUrl, остальной текст цел', () => {
    expect(redactUrlsInText(CORS_MESSAGE)).toBe(CORS_MESSAGE.replace('SECRET-QUERY-123', REDACTED));
  });

  it('текст без адресов и адрес без секретов не меняются', () => {
    for (const text of ['', 'TypeError: x is undefined', 'see http://localhost:5173/settings?tab=1#top for details']) expect(redactUrlsInText(text), text).toBe(text);
  });

  it('несколько адресов подряд: wss и регистр схемы, user:pass@, фрагмент OAuth; адрес кончается на пробеле, кавычке, обратной кавычке и <>', () => {
    const text = [
      'GET HTTPS://u:p@x.y/a?api_key=k1 -> wss://x.y/ws?access_token=t1&id=2',
      '"http://x.y/cb#access_token=t2&state=s"',
      '`http://x.y/?password=p3`',
      '<http://x.y/?session=s4>',
      'ok',
    ].join(' ');
    expect(redactUrlsInText(text)).toBe(
      [
        `GET HTTPS://x.y/a?api_key=${REDACTED} -> wss://x.y/ws?access_token=${REDACTED}&id=2`,
        `"http://x.y/cb#access_token=${REDACTED}&state=s"`,
        `\`http://x.y/?password=${REDACTED}\``,
        `<http://x.y/?session=${REDACTED}>`,
        'ok',
      ].join(' '),
    );
  });

  it('текст задаёт страница: на сериях «h», «a.», «http» и на тысячах параметров перебор линейный, окно не виснет', () => {
    // Порог по времени, а не таймаут теста: цикл синхронный. Образец любой схемы `[a-z][a-z0-9+.-]*://` на 50 000 знаков «h» (без `\b`)
    // или «a.» (и с `\b`) занимает секунды и растёт квадратично; якорь `\b(?:https?|wss?)` — доли миллисекунды.
    for (const text of ['h'.repeat(50_000), 'a.'.repeat(50_000), 'http'.repeat(50_000), 'http:/'.repeat(50_000), `http://x/?${'a=b&'.repeat(50_000)}`]) {
      const started = performance.now();
      redactUrlsInText(text);
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(500);
    }
  });
});

describe('redactBody', () => {
  it('вложенный JSON: секретные ключи на любой глубине и в массивах — <redacted>', () => {
    const body = JSON.stringify({ user: { name: 'demo', account: { password: 'p1' } }, items: [{ apiKey: 'k1' }, { id: 1 }], session_id: 's1' });
    expect(JSON.parse(redactBody(body, 'application/json; charset=utf-8'))).toEqual({
      user: { name: 'demo', account: { password: REDACTED } },
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

  it('разобранный JSON, на который маска не легла (вложенность глубже стека), не отдаётся как есть — тело целиком <redacted>', () => {
    // JSON.parse такую глубину разбирает, а обход маски и JSON.stringify падают с RangeError. Молча вернуть тело значило бы
    // отдать секрет, а unmaskableJson его не отсеет — тело разбирается.
    const depth = 20000;
    const body = `${'['.repeat(depth)}{"password":"hunter2"}${']'.repeat(depth)}`;
    // Булево сравнение: при провале vitest не печатает в сообщение тело на 40 КБ.
    expect(redactBody(body, 'application/json') === REDACTED).toBe(true);
  });

  it('форма: секретные параметры — <redacted>', () => {
    expect(redactBody('user=demo&password=p1', 'application/x-www-form-urlencoded')).toBe(`user=demo&password=${REDACTED}`);
  });

  it('JSON под типом формы (jQuery со строкой в data, старый axios, неверный заголовок) маскируется как JSON, а не проходит как форма с паролем на месте', () => {
    // Тип в заголовке врёт, но вид тела — скобка: тот же закон, что у text/plain, — JSON узнаётся по типу или по первой скобке.
    const body = '{"user":"demo","password":"hunter2"}';
    const form = 'application/x-www-form-urlencoded; charset=UTF-8';
    expect(JSON.parse(redactBody(body, form))).toEqual({ user: 'demo', password: REDACTED });
    expect(JSON.parse(redactBody(`  [${body}]`, form))).toEqual([{ user: 'demo', password: REDACTED }]);
    expect(unmaskableJson(body, form)).toBe(false);
  });

  it('обрезанный JSON под типом формы остаётся как есть и узнаётся unmaskableJson — форма не режет его по первому «=»', () => {
    // «=» внутри значения: ветка формы разрезала бы тело по нему и вернула бы мусор вместо исходного текста.
    const cut = '{"password": "p1", "next": "https://x.y/cb?a=b", "note": "tr';
    expect(redactBody(cut, 'application/x-www-form-urlencoded')).toBe(cut);
    expect(unmaskableJson(cut, 'application/x-www-form-urlencoded')).toBe(true);
  });

  it('не-JSON тело не меняется, только режется по пределу с пометкой', () => {
    const text = 'password=p1 in plain text';
    expect(redactBody(text, 'text/plain')).toBe(text);
    expect(redactBody('x'.repeat(5000), 'text/plain', 4096)).toBe(`${'x'.repeat(4096)}${S.contextFile.truncated}`);
    expect(redactBody('x'.repeat(4096), 'text/plain', 4096)).toBe('x'.repeat(4096));
  });

  it('тело в десятки мегабайт режется за время, не зависящее от длины: точки не раскладываются в массив (длину задаёт страница)', () => {
    const huge = 'x'.repeat(50_000_000);
    const started = performance.now();
    const out = redactBody(huge, 'text/plain', 4096);
    const elapsed = performance.now() - started;
    expect(out).toBe(`${'x'.repeat(4096)}${S.contextFile.truncated}`);
    // Порог по времени, а не таймаут теста: вызов синхронный. Прежний `Array.from` по телу — секунда с лишним и сотни МБ кучи.
    expect(elapsed).toBeLessThan(300);
  });
});

// Тело и Content-Type запроса — как их кладёт Chromium в Electron 44.4.5 (fetch(url, { body: formData }) и form.submit() с enctype
// multipart/form-data): граница `----WebKitFormBoundary…`, перевод строки CRLF, закрывающий разделитель с «--».
const BOUNDARY = '----WebKitFormBoundaryHFk0FB154gnvJpA4';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
const LOGIN_BODY = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="username"\r\n\r\ndemo\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="password"\r\n\r\nMULTIPART-SECRET\r\n--${BOUNDARY}--\r\n`;

describe('redactBody: multipart/form-data (FormData, форма с файлом)', () => {
  it('значение части с секретным именем — <redacted>, прочие части, заголовки и разделители — как были; предел режет уже замаскированное', () => {
    const masked = LOGIN_BODY.replace('MULTIPART-SECRET', REDACTED);
    expect(redactBody(LOGIN_BODY, MULTIPART)).toBe(masked);
    expect(redactBody(LOGIN_BODY, MULTIPART, 150)).toBe(`${masked.slice(0, 150)}${S.contextFile.truncated}`);
  });

  it('имя без кавычек и с индексами, регистр заголовка и параметра, «name=» и «;» в имени файла, значение в несколько строк; преамбула и эпилог целы', () => {
    const body = [
      'This is a preamble that clients ignore.',
      `--${BOUNDARY}`,
      'content-disposition: form-data; NAME=user[Password]',
      '',
      'p1',
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="avatar"; filename="my name=token.png"',
      'Content-Type: image/png',
      '',
      'PNG-BYTES',
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; filename="my; name=up.bin"; name="api_key"',
      'Content-Type: application/octet-stream',
      '',
      'KEY-BYTES',
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="client_secret"; filename="s.txt"',
      'Content-Type: text/plain',
      '',
      'secret line one',
      'secret line two',
      `--${BOUNDARY}--`,
      'This is an epilogue that clients ignore.',
      '',
    ].join('\r\n');
    expect(redactBody(body, MULTIPART)).toBe(
      [
        'This is a preamble that clients ignore.',
        `--${BOUNDARY}`,
        'content-disposition: form-data; NAME=user[Password]',
        '',
        REDACTED,
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="avatar"; filename="my name=token.png"',
        'Content-Type: image/png',
        '',
        'PNG-BYTES',
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; filename="my; name=up.bin"; name="api_key"',
        'Content-Type: application/octet-stream',
        '',
        REDACTED,
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="client_secret"; filename="s.txt"',
        'Content-Type: text/plain',
        '',
        REDACTED,
        `--${BOUNDARY}--`,
        'This is an epilogue that clients ignore.',
        '',
      ].join('\r\n'),
    );
  });

  it('перевод строки только LF — те же части; boundary в кавычках, со знаками, особыми для регулярных выражений, и с параметрами после него', () => {
    const lf = [`--${BOUNDARY}`, 'Content-Disposition: form-data; name="password"', '', 'LF-SECRET', `--${BOUNDARY}--`, ''].join('\n');
    expect(redactBody(lf, MULTIPART)).toBe(lf.replace('LF-SECRET', REDACTED));
    // Знаки из bchars RFC 2046: апостроф, скобки, плюс, запятая, точка, двоеточие, равно, вопрос и пробел внутри.
    const odd = "a'b(c)+_,-./:=?d e";
    const body = `--${odd}\r\nContent-Disposition: form-data; name="auth"\r\n\r\nODD-SECRET\r\n--${odd}--\r\n`;
    expect(redactBody(body, `multipart/form-data; boundary="${odd}"; charset=utf-8`)).toBe(body.replace('ODD-SECRET', REDACTED));
  });

  it('тело оборвано на пределе postData (64 КБ): значение секретной части без закрывающего разделителя — <redacted>, обрыв в заголовке ничего не открывает', () => {
    const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="password"\r\n\r\n`;
    expect(redactBody(`${head}CUT-SECR`, MULTIPART)).toBe(`${head}${REDACTED}`);
    // Обрыв посреди заголовка следующей части: значения в ней ещё нет, строка заголовка остаётся как была.
    const cutInHeader = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="user"\r\n\r\ndemo\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="passw`;
    expect(redactBody(cutInHeader, MULTIPART)).toBe(cutInHeader);
  });

  it('нет boundary в типе или его разделителя нет в теле — разобрать тело нечем, оно целиком <redacted>', () => {
    expect(redactBody(LOGIN_BODY, 'multipart/form-data')).toBe(REDACTED);
    expect(redactBody(LOGIN_BODY, 'multipart/form-data; boundary=')).toBe(REDACTED);
    expect(redactBody(LOGIN_BODY, 'multipart/form-data; boundary=OTHER')).toBe(REDACTED);
    // Тип врёт, тело — JSON: части не найти, и по JSON-ветке оно тоже не пойдёт.
    expect(redactBody('{"password":"x"}', MULTIPART)).toBe(REDACTED);
  });

  it('части без имён (multipart/mixed, related) остаются как были: решает имя, как у ключей JSON', () => {
    const body = `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nplain part\r\n--${BOUNDARY}--\r\n`;
    expect(redactBody(body, `multipart/mixed; boundary=${BOUNDARY}`)).toBe(body);
  });

  it('boundary со словом «json» не делает multipart «JSON, который не разбирается»: тело маскируется по частям', () => {
    // Случайная граница WebKit (16 знаков) содержит «json» примерно раз на семьдесят тысяч запросов.
    const boundary = '----WebKitFormBoundaryjsonX1y2Z3a4';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\nJSON-BOUNDARY-SECRET\r\n--${boundary}--\r\n`;
    const type = `multipart/form-data; boundary=${boundary}`;
    expect(unmaskableJson(body, type)).toBe(false);
    expect(redactBody(body, type)).toBe(body.replace('JSON-BOUNDARY-SECRET', REDACTED));
  });

  it('тысячи частей, значение в сотни тысяч строк и очень длинная строка заголовка: перебор линейный, стек не переполняется', () => {
    // Порог по времени, а не таймаут теста: цикл синхронный. `push(...строки)` на сотнях тысяч элементов роняет стек — поэтому цикл.
    const part = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n`;
    const manyLines = 'x\r\n'.repeat(300_000);
    const bodies = [
      `${part.repeat(20_000)}--${BOUNDARY}--\r\n`,
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${manyLines}--${BOUNDARY}--\r\n`,
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${manyLines}--${BOUNDARY}--\r\n`,
      `--${BOUNDARY}\r\nContent-Disposition: form-data${'; name '.repeat(30_000)}\r\n\r\nv\r\n--${BOUNDARY}--\r\n`,
      `--${BOUNDARY}\r\nContent-Disposition: form-data;${' '.repeat(50_000)}x\r\n\r\nv\r\n--${BOUNDARY}--\r\n`,
    ];
    for (const [index, body] of bodies.entries()) {
      const started = performance.now();
      redactBody(body, MULTIPART);
      expect(performance.now() - started, `тело ${index}`).toBeLessThan(500);
    }
  });
});

describe('redactSecretsInText (S1): секреты по виду значения в тексте консоли', () => {
  const R = REDACTED;
  const cases: Array<[string, string, string]> = [
    ['Bearer, пароль и ключ в одном сообщении', 'Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln; password=hunter2; api_key=AKIAIOSFODNN7EXAMPLE', `Auth failed: Bearer ${R}; password=${R}; api_key=${R}`],
    ['относительный адрес с query', 'GET /reset?token=abc 404', `GET /reset?token=${R} 404`],
    ['code OAuth в адресе', 'http://x/cb?code=AUTH&state=1', `http://x/cb?code=${R}&state=1`],
    ['разделитель «;» в query', 'http://x/a?b=1;token=semicolon', `http://x/a?b=1;token=${R}`],
    ['code в относительном адресе', 'redirect to /cb?code=AUTH&state=1', `redirect to /cb?code=${R}&state=1`],
    ['JSON в тексте', 'got {"password":"x","token":"y","user":"bob"}', `got {"password":"${R}","token":"${R}","user":"bob"}`],
    ['объект с bare-ключом', 'config {api_key: sk-live-123, user: bob}', `config {api_key: ${R}, user: bob}`],
    ['заголовок со схемой', 'Authorization: Bearer abc.def', `Authorization: ${R}`],
    ['Basic с base64', 'sent Basic dXNlcjpwYXNzd29yZA== to server', `sent Basic ${R} to server`],
    ['JWT без схемы', 'token was eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln end', `token was ${R} end`],
    ['новые имена', 'jwt=aaa pwd=bbb x-xsrf=ccc signature=ddd credential=eee private=fff sid=ggg sig=hhh pass=iii otp=123456', `jwt=${R} pwd=${R} x-xsrf=${R} signature=${R} credential=${R} private=${R} sid=${R} sig=${R} pass=${R} otp=${R}`],
  ];
  for (const [name, input, output] of cases) {
    it(name, () => expect(redactSecretsInText(input)).toBe(output));
  }

  it('обычный текст, слова «Basic usage», «code: 404» и «keyboard=1» не меняются; повторная маска ничего не меняет', () => {
    for (const text of ['Basic usage example', 'Failed with code: 404', 'keyboard=1 monkey=2', 'Token expired', 'GET /api/users 200', 'passing=3']) expect(redactSecretsInText(text), text).toBe(text);
    const once = redactSecretsInText('password=hunter2 Bearer abc');
    expect(redactSecretsInText(once)).toBe(once);
  });

  it('текст задаёт страница: длинные серии имён, кавычек и «=» обрабатываются за линейное время', () => {
    const started = Date.now();
    for (const text of ['a'.repeat(200_000), '"'.repeat(100_000), 'a='.repeat(50_000), `password=${'"'.repeat(50_000)}`, `Bearer ${'a'.repeat(100_000)}`, 'a.'.repeat(60_000), '/a?'.repeat(40_000)]) redactSecretsInText(text);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('redactUrl: новые имена, code и «;» (S3, S4)', () => {
  it('code — секрет только в параметрах адреса; ; делит пары; новые имена', () => {
    expect(redactUrl('http://x/cb?code=AUTH&state=1')).toBe(`http://x/cb?code=${REDACTED}&state=1`);
    expect(redactUrl('http://x/a?b=1;token=semicolon')).toBe(`http://x/a?b=1;token=${REDACTED}`);
    expect(redactUrl('http://x/a?X-Amz-Signature=abc&sid=1&sig=2&PHPSESSID=3')).toBe(`http://x/a?X-Amz-Signature=${REDACTED}&sid=${REDACTED}&sig=${REDACTED}&PHPSESSID=${REDACTED}`);
    expect(isSecretName('code')).toBe(false);
    for (const name of ['signature', 'x-credential', 'jwt', 'bearer', 'xsrf-cookie', 'pwd', 'private', 'sid', 'sig', 'pass', 'otp', 'userPass']) expect(isSecretName(name), name).toBe(true);
    for (const name of ['passenger', 'signal', 'sidebar', 'bypass', 'otpx']) expect(isSecretName(name), name).toBe(false);
  });
});

describe('redactBody: строки JSON, пары имя/значение, формы без типа, большие числа (S2, S4, A8)', () => {
  const json = (value: unknown): unknown => JSON.parse(redactBody(JSON.stringify(value), 'application/json'));

  it('строковые значения: адрес с токеном, JWT, JSON внутри строки, пара «пароль=значение»', () => {
    expect(json({ link: 'http://localhost:3000/verify?token=abc' })).toEqual({ link: `http://localhost:3000/verify?token=${REDACTED}` });
    expect(json({ jwt: 'x', note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln' })).toEqual({ jwt: REDACTED, note: REDACTED });
    expect(json({ payload: '{"password":"x","a":1}' })).toEqual({ payload: `{"password":"${REDACTED}","a":1}` });
    expect(json({ log: 'login password=hunter2 failed' })).toEqual({ log: `login password=${REDACTED} failed` });
    expect(redactBody('"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln"', 'application/json')).toBe(JSON.stringify(REDACTED, null, 2));
  });

  it('объект {name, value} и {key, value}: значение секретного имени скрыто', () => {
    expect(json([{ name: 'password', value: 'hunter2' }])).toEqual([{ name: 'password', value: REDACTED }]);
    expect(json([{ name: 'theme', value: 'dark' }])).toEqual([{ name: 'theme', value: 'dark' }]);
    expect(json([{ key: 'api_key', value: 'abc' }])).toEqual([{ key: REDACTED, value: REDACTED }]);
    expect(json([{ name: 'Cookie', value: { a: 1 } }])).toEqual([{ name: 'Cookie', value: REDACTED }]);
  });

  it('форма под text/plain и без типа маскируется как форма; обычный текст и JSON со знаком «=» не страдают', () => {
    expect(redactBody('user=bob&password=hunter2', 'text/plain')).toBe(`user=bob&password=${REDACTED}`);
    expect(redactBody('user=bob&password=hunter2', null)).toBe(`user=bob&password=${REDACTED}`);
    expect(redactBody('user=bob;password=hunter2', 'text/plain; charset=utf-8')).toBe(`user=bob;password=${REDACTED}`);
    expect(redactBody('just some text = here', 'text/plain')).toBe('just some text = here');
    expect(redactBody('a=b&c', 'text/plain')).toBe('a=b&c');
    expect(JSON.parse(redactBody('{"next":"a=b","password":"x"}', 'text/plain'))).toEqual({ next: 'a=b', password: REDACTED });
    // code в форме — не секрет (только в параметрах адреса)
    expect(redactBody('code=404&x=1', 'text/plain')).toBe('code=404&x=1');
  });

  it('Фокус ревью 4: {"error":{"code":404}} и большое целое остаются читаемыми и точными', () => {
    const text = '{"error":{"code":404},"id":9007199254740993,"list":[-9007199254740995,12,1.5],"token":9007199254740993}';
    const masked = redactBody(text, 'application/json');
    expect(masked).toContain('"code": 404');
    expect(masked).toContain('"id": 9007199254740993');
    expect(masked).toContain('-9007199254740995');
    expect(masked).toContain('1.5');
    expect(masked).toContain(`"token": "${REDACTED}"`);
    expect(redactBody('{"error":{"code":404},"id":9007199254740993}', 'application/json')).toBe('{\n  "error": {\n    "code": 404\n  },\n  "id": 9007199254740993\n}');
  });
});
