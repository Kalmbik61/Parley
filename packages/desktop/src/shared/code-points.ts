/**
 * Первые `limit` кодовых точек: суррогатная пара эмодзи не рвётся. Длину строки здесь задаёт страница (значение стиля,
 * имя доступности, путь адреса, тело ответа), поэтому строка не раскладывается целиком: `Array.from(text)` стоит больше
 * восьми байт на знак, и на строке в сотни мегабайт он кладёт main (остановка, затем нехватка кучи на все окна). Итератор
 * читает ровно `limit + 1` точку и останавливается, цена от длины строки не зависит.
 */
export function cutCodePoints(text: string, limit: number): { text: string; cut: boolean } {
  // Юнитов UTF-16 не больше предела — точек тем более.
  if (text.length <= limit) return { text, cut: false };
  let end = 0;
  let count = 0;
  for (const point of text) {
    // Точка сверх предела нашлась — строка длиннее; режем по концу последней принятой, пара не рвётся.
    if (count >= limit) return { text: text.slice(0, end), cut: true };
    end += point.length;
    count += 1;
  }
  return { text, cut: false };
}
