import { S } from '../shared/strings.js';

/**
 * Выход из приложения гасит хост (решение 2026-10-16). Закрытое окно оставляет агентов работать, а выход
 * (Dock → «Завершить», ⌘Q, меню Parley → Quit) спрашивает человека и останавливает хост со всеми сессиями.
 *
 * Вопрос задаётся на `will-quit`, а не на `before-quit`: к этому моменту вопрос о несохранённых буферах
 * (`guardWindowClose`) уже позади и окна закрыты, так что диалог — системный, без родительского окна. Отмена
 * (`preventDefault`) держит выход, пока идёт вопрос и остановка хоста; потом выход разрешается и повторяется.
 */

/** Узкая часть `app`, нужная сторожу. */
interface QuitGuardApp {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  removeListener(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

export interface QuitGuardDeps {
  /** Число живых сессий; null — хост не ответил, число неизвестно. */
  liveSessions(): Promise<number | null>;
  ask(count: number | null): Promise<'stop' | 'cancel'>;
  stopHost(): Promise<void>;
  /** Выход отменён: вернуть главное окно. */
  onCancel(): void;
  /** Тестовый режим: выход по-старому, хост живёт. */
  keepHost: boolean;
  log(line: string): void;
}

/** Текст вопроса о выходе; `count` null — хост не отвечает. */
export function quitQuestion(count: number | null): { message: string; detail: string; buttons: [string, string] } {
  return { message: S.quit.title, detail: S.quit.detail(count), buttons: [S.quit.stop(count), S.common.cancel] };
}

export function guardAppQuit(app: QuitGuardApp, deps: QuitGuardDeps): { systemShutdown(): void; dispose(): void } {
  let allowed = false;
  let busy = false;
  let system = false;

  const run = async (): Promise<void> => {
    try {
      let stop = system;
      if (!stop) {
        const count = await deps.liveSessions();
        stop = count === 0 || (await deps.ask(count)) === 'stop';
      }
      if (!stop) {
        deps.onCancel();
        busy = false;
        return;
      }
      try {
        await deps.stopHost();
      } catch (error) {
        deps.log(`quit: host stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      deps.log(`quit: ${error instanceof Error ? error.message : String(error)}`);
    }
    allowed = true;
    app.quit();
  };

  const onWillQuit = (event: { preventDefault(): void }): void => {
    if (deps.keepHost || allowed) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    void run();
  };

  app.on('will-quit', onWillQuit);
  return {
    systemShutdown: () => {
      system = true;
    },
    dispose: () => {
      app.removeListener('will-quit', onWillQuit);
    },
  };
}
