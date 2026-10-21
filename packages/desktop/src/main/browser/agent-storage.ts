/**
 * Куки и веб-хранилище страницы агента (решения владельца 1, 5, 6). Граница — адрес и origin СТРАНИЦЫ агента
 * (`contents.getURL()`): аргумента `url` или `domain` нет. Значение httpOnly-куки не выходит отсюда никогда.
 */
import type { WebContents } from 'electron';
import { AGENT_INPUT, AGENT_LIMITS } from '@parley/protocol';
import type { BrowserAgentArgs, BrowserAgentCookie, BrowserAgentCookiesResult, BrowserAgentStorageResult } from '@parley/protocol';
import { cutCodePoints } from '../../shared/code-points.js';
import { REDACTED, isSecretName, redactSecretsInText } from '../../shared/redact.js';
import { AgentOpError } from './agent-errors.js';
import { urlForAgent } from './agent-url.js';
import type { Inspector } from './inspector.js';

/** Вместо значения httpOnly-куки. */
export const HTTPONLY_HIDDEN = '<httpOnly: hidden>';

/** Длина превью значения в списке хранилища, кодовых точек. */
const PREVIEW_POINTS = 200;

export interface AgentStorage {
  cookiesOf(contents: WebContents, agentId: string, args: BrowserAgentArgs<'cookies'>): Promise<BrowserAgentCookiesResult>;
  storageOf(contents: WebContents, agentId: string, args: BrowserAgentArgs<'storage'>): Promise<BrowserAgentStorageResult>;
}

interface Deps {
  cookies: Pick<Electron.Cookies, 'get' | 'set' | 'remove'>;
  inspector: Pick<Inspector, 'send'>;
}

/** Адрес страницы агента; не http(s) (`about:blank`, ошибка загрузки) — отказ. */
function pageUrl(contents: WebContents, tab: string): URL {
  try {
    const url = new URL(contents.getURL());
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // ниже — тот же отказ
  }
  throw new AgentOpError('bad_request', `Page ${tab} shows no web page yet: open or navigate it first.`);
}

/** Идентификатор хранилища CDP: origin и вид (спайк В7: `securityOrigin` без `DOMStorage.enable`). */
const storageIdOf = (origin: string, local: boolean): { securityOrigin: string; isLocalStorage: boolean } => ({ securityOrigin: origin, isLocalStorage: local });

export function createAgentStorage(deps: Deps): AgentStorage {
  async function cookiesOf(contents: WebContents, _agentId: string, args: BrowserAgentArgs<'cookies'>): Promise<BrowserAgentCookiesResult> {
    const page = pageUrl(contents, args.tab);
    const url = page.href;
    // В ответ адрес идёт с маской; куки читаются по настоящему.
    const shown = urlForAgent(url);
    if (args.action === 'list') {
      const all = await deps.cookies.get({ url });
      const cookies: BrowserAgentCookie[] = all.slice(0, AGENT_LIMITS.listEntries).map((cookie) => {
        const item: BrowserAgentCookie = {
          name: cookie.name,
          domain: cookie.domain ?? '',
          path: cookie.path ?? '/',
          secure: cookie.secure === true,
          httpOnly: cookie.httpOnly === true,
          sameSite: cookie.sameSite ?? 'unspecified',
          session: cookie.session === true,
          expires: cookie.expirationDate === undefined ? null : new Date(cookie.expirationDate * 1000).toISOString(),
          size: cookie.name.length + cookie.value.length,
        };
        if (args.values === true) item.value = cookie.httpOnly === true ? HTTPONLY_HIDDEN : cutCodePoints(cookie.value, AGENT_INPUT.cookieValue).text;
        return item;
      });
      const notes = all.length > cookies.length ? [`${all.length - cookies.length} more cookies are not shown.`] : [];
      return { tab: args.tab, url: shown, cookies, notes };
    }
    const name = args.name as string;
    if (args.action === 'set') {
      await deps.cookies.set({
        url,
        name,
        value: args.value as string,
        ...(args.path === undefined ? {} : { path: args.path }),
        ...(args.secure === undefined ? {} : { secure: args.secure }),
        ...(args.httpOnly === undefined ? {} : { httpOnly: args.httpOnly }),
        ...(args.sameSite === undefined ? {} : { sameSite: args.sameSite }),
        ...(args.expires === undefined ? {} : { expirationDate: args.expires }),
      });
      return { tab: args.tab, url: shown, done: `Set cookie ${name} for ${page.origin}.` };
    }
    await deps.cookies.remove(url, name);
    return { tab: args.tab, url: shown, done: `Deleted cookie ${name} for ${page.origin}.` };
  }

  async function storageOf(contents: WebContents, _agentId: string, args: BrowserAgentArgs<'storage'>): Promise<BrowserAgentStorageResult> {
    const origin = pageUrl(contents, args.tab).origin;
    const local = args.area === 'local';
    const storageId = storageIdOf(origin, local);
    const where = `${local ? 'localStorage' : 'sessionStorage'} of ${origin}`;
    const base = { tab: args.tab, origin, area: args.area };
    const read = async (): Promise<Array<[string, string]>> => {
      const { entries } = await deps.inspector.send<{ entries: Array<[string, string]> }>(contents.id, 'DOMStorage.getDOMStorageItems', { storageId });
      return entries;
    };
    switch (args.action) {
      case 'list': {
        const all = await read();
        const entries = all.slice(0, AGENT_LIMITS.listEntries).map(([key, value]) => ({
          key,
          value: isSecretName(key) ? REDACTED : redactSecretsInText(cutCodePoints(value, PREVIEW_POINTS).text),
          size: value.length,
        }));
        const notes = all.length > entries.length ? [`${all.length - entries.length} more entries are not shown.`] : [];
        return { ...base, entries, total: all.length, notes };
      }
      case 'get': {
        const key = args.key as string;
        const found = (await read()).find(([name]) => name === key);
        if (found === undefined) return { ...base, key, value: null, truncated: false };
        const cut = cutCodePoints(found[1], AGENT_LIMITS.storageValue);
        return { ...base, key, value: cut.text, truncated: cut.cut };
      }
      case 'set': {
        const key = args.key as string;
        await deps.inspector.send(contents.id, 'DOMStorage.setDOMStorageItem', { storageId, key, value: args.value as string });
        return { ...base, done: `Set ${key} in ${where}.` };
      }
      case 'delete': {
        const key = args.key as string;
        await deps.inspector.send(contents.id, 'DOMStorage.removeDOMStorageItem', { storageId, key });
        return { ...base, done: `Deleted ${key} from ${where}.` };
      }
      default:
        await deps.inspector.send(contents.id, 'DOMStorage.clear', { storageId });
        return { ...base, done: `Cleared ${where}.` };
    }
  }

  return { cookiesOf, storageOf };
}
