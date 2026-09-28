/**
 * Тело вкладки терминала (кусок 2.5, спека 5.5): пустое место-заглушка. Сам
 * терминал живёт в слое поверхностей работы (`layout/SurfaceLayer.tsx`) и
 * привязан CSS-якорем к телу группы (`GroupView.tsx`, `--g-<groupId>`) —
 * поэтому перенос вкладки между группами не пересоздаёт xterm.
 */

export function TerminalBody(): JSX.Element {
  return <div data-testid="terminal-body" className="h-full w-full" />;
}
