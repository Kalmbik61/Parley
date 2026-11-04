/** Громкость записи (спека 3.2): `volumechange` библиотеки идёт от −2 до 10, полоска берёт долю 0…1. */
export function levelOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, value)) / 10;
}
