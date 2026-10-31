// Ключ лимитов по адресу клиента (ревью A5, m1; та же функция, что в relay): IPv6 — /64, `::ffff:a.b.c.d` — IPv4.
import { isIP } from 'node:net';

/** Восемь 16-битных групп адреса IPv6, уже проверенного `isIP`. */
function groupsV6(ip: string): number[] {
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => parseInt(g, 16));
  const left = parse(head);
  if (rest === undefined) return left;
  const right = parse(rest);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * IPv4 — как есть; IPv4, отображённый в IPv6, — как IPv4; IPv6 — префикс /64 (один абонент обычно владеет целой
 * /64, и ротация адресов внутри неё не должна давать новые окна лимитов). Не адрес — строка как есть.
 */
export function ipKey(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return raw;
  const g = groupsV6(ip);
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}
