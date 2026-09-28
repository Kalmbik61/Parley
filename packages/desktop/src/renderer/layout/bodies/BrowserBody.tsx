/**
 * Тело вкладки браузера (кусок 9.2a, спека 12.2): пустое место. Строка над страницей, заглушка
 * новой вкладки и сама страница живут в слое поверхностей работы (`browser/BrowserSurface.tsx`)
 * и привязаны CSS-якорем к телу группы — перенос вкладки не перезагружает страницу.
 */

export function BrowserBody(): JSX.Element {
  return <div data-testid="browser-body" className="h-full w-full" />;
}
