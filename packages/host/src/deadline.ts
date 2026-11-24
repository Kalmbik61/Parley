/**
 * Ждёт `work` не дольше `ms`. Отказ `work` пробрасывается; таймер снимается всегда.
 * Зависшая работа продолжает жить в фоне: её поздний отказ уже обработан здесь и не станет `unhandledRejection`.
 */
export async function withDeadline(work: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([work.then(() => 'done' as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}
