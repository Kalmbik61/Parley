/**
 * Отмена самого Monaco (раунд fix-7.3, п. 7): Monaco отменяет свои отложенные операции при
 * `dispose` редактора отклонённым промисом `Error('Canceled')` без обработчика. Гасить такую
 * отмену можно, только если она из кода Monaco — чужая `Error('Canceled')` окна (например, у
 * `AbortController`) должна дойти до консоли и `pageerror`.
 *
 * Код Monaco узнаётся по стеку: в собранном окне Monaco лежит в одном чанке с `monaco-setup.ts`
 * (`monacoUrl` — его `import.meta.url`), в dev — модули пакета `monaco-editor`.
 */
export function isMonacoCancel(reason: unknown, monacoUrl: string): boolean {
  if (!(reason instanceof Error) || reason.name !== 'Canceled' || reason.message !== 'Canceled') return false;
  const stack = reason.stack ?? '';
  return stack.includes(monacoUrl) || stack.includes('monaco-editor');
}
