/** `map` с ограничением одновременных вызовов; порядок результатов — порядок входа. */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Сколько файлов истории агентов индекс читает одновременно (раунд lane-r3, п. 1).
 * Тысяча чтений разом занимала пул libuv хоста на секунды, и его собственная файловая
 * работа (`works.create`, журнал хуков) ждала за ними; при 8 индекс дочитывается чуть
 * дольше, а хост отвечает без затора.
 */
export const INDEX_READ_CONCURRENCY = 8;
