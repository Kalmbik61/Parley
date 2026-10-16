/**
 * Loopback для агента (спека 2026-10-07-browser-devtools-agent-design.md, раздел 7): URL со схемой http или https и
 * хостом `localhost`, `*.localhost`, `127.0.0.0/8` или `[::1]`. Адреса локальной сети, `0.0.0.0` и прочие — не loopback.
 * Функция одна на всё окно: ей пользуются `agent-ops.ts` (этап B2) и дальше `guard.ts` и умолчание «Agent access» вкладки
 * (этапы C и D). Разбор — WHATWG `URL`: он сам приводит `127.1`, десятичную и шестнадцатеричную запись IPv4 к виду a.b.c.d
 * и отделяет имя хоста от `user@`: у `http://localhost@evil.com/` хост — `evil.com`.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Точка в конце имени (`localhost.`) — то же имя: её снимают и браузер, и DNS.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  return IPV4.exec(host)?.[1] === '127';
}
