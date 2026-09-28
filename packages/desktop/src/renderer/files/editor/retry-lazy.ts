/**
 * Ленивый компонент, который «Retry» действительно грузит заново (раунд fix-7.3, п. 6).
 * `React.lazy` запоминает отклонённый промис загрузки: повтор того же ленивого компонента после
 * сбоя чанка отказывает мгновенно, без нового `import()`. Retry здесь заводит новый ленивый
 * компонент с новым вызовом `load`; удачная загрузка общая для всех тел — второй раз не грузится.
 *
 * Оговорка: повторит ли движок сам запрос чанка, решает он — по спеке HTML неудачный модуль из
 * карты модулей не запоминается, но это уже его кэш, не наш.
 */

import { lazy, useState, type ComponentType, type LazyExoticComponent } from 'react';

export function lazyWithRetry<P extends object>(
  load: () => Promise<ComponentType<P>>,
): { use(): { component: LazyExoticComponent<ComponentType<P>>; retry(): void } } {
  const make = (): LazyExoticComponent<ComponentType<P>> => lazy(async () => ({ default: await load() }));
  let latest = make();
  return {
    use: () => {
      // Перерисовать тело с новым ленивым компонентом: `latest` — не состояние React.
      const [, rerender] = useState(0);
      return {
        component: latest,
        retry: () => {
          latest = make();
          rerender((value) => value + 1);
        },
      };
    },
  };
}
