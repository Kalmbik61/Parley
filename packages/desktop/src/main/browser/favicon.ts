/**
 * Favicon вкладки браузера (кусок 9.2a, спека 12.1). Адреса из `page-favicon-updated` — http(s),
 * а CSP окна пускает картинки только `'self' data: blob:`: качает main и отдаёт окну `data:`.
 *
 * Адрес значка выбирает страница, поэтому здесь всё — пределы: чужой origin превратил бы main в
 * рассыльщика GET с куками раздела на любые адреса, а чтение без предела — в склад сотен мегабайт.
 */

export const FAVICON_LIMITS = { bytes: 65536, timeoutMs: 5000 } as const; // 64 КБ — спека; 5 с — план

/** `data:image/<тип>` с параметрами или без: `data:image/png;base64,…`, `data:image/svg+xml,…`. */
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Тело потоком до предела; больше предела — null и обрыв чтения, а не `arrayBuffer()` целиком. */
async function readLimited(response: Response): Promise<Buffer | null> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FAVICON_LIMITS.bytes) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function download(
  iconUrl: string,
  signal: AbortSignal,
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>,
): Promise<string | null> {
  const response = await fetch(iconUrl, { signal });
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const length = Number(response.headers.get('content-length') ?? '0');
  if (!response.ok || !mime.startsWith('image/') || length > FAVICON_LIMITS.bytes) {
    // Тело не читается вовсе: соединение отпускаем сразу.
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = await readLimited(response);
  if (bytes === null || bytes.length === 0) return null;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * Favicon в data:. data:image/* до 64 КБ — как есть, без загрузки. http(s) — только того же origin, что
 * страница, Content-Type image/*; Content-Length больше 64 КБ — отказ без чтения, поток обрывается на
 * 64 КБ; всё — за 5 с. Иначе null.
 */
export async function fetchFavicon(
  iconUrl: string,
  pageUrl: string,
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>,
): Promise<string | null> {
  if (iconUrl.startsWith('data:')) {
    // Так favicon отдают dev-серверы; строка идёт в окно как есть — предел на её длину.
    return DATA_IMAGE.test(iconUrl) && iconUrl.length <= FAVICON_LIMITS.bytes ? iconUrl : null;
  }
  const icon = parse(iconUrl);
  const page = parse(pageUrl);
  if (icon === null || page === null) return null;
  if (icon.protocol !== 'http:' && icon.protocol !== 'https:') return null;
  if (icon.origin !== page.origin) return null;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Гонка с таймером, а не только AbortSignal: fetch, который сигнал не слушает, всё равно
  // не держит ответ дольше предела.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, FAVICON_LIMITS.timeoutMs);
  });
  try {
    return await Promise.race([download(iconUrl, controller.signal, fetch).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
