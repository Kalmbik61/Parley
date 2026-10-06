/** Сумма целых чисел от `from` до `to` включительно. */
export function sumRange(from, to) {
  let total = 0;
  for (let n = from; n <= to; n += 1) total += n;
  return total;
}
