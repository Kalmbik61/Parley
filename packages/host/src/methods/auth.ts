import type { Handler } from '../context.js';
import { accountEntry } from '../providers/auth-service.js';
import type { AuthService } from '../providers/auth-service.js';

/**
 * Шесть методов входа в аккаунт подписки (спека подписок 5.5, К14): состояние, вход в своём маленьком PTY, ввод кода
 * из браузера, размер терминала, отмена и выход. Провайдер — всегда аккаунт реестра: встроенный `claude`, GLM, свой
 * провайдер с адресом и неизвестный id получают `bad_request` (`<id> is not an account`). Вывод и выход процесса входа
 * окно получает событиями `providers.signInOutput` и `providers.signInExit`, не ответом.
 */
export function createAuthHandlers(auth: AuthService): {
  'providers.authStatus': Handler<'providers.authStatus'>;
  'providers.signIn': Handler<'providers.signIn'>;
  'providers.signInInput': Handler<'providers.signInInput'>;
  'providers.signInResize': Handler<'providers.signInResize'>;
  'providers.cancelSignIn': Handler<'providers.cancelSignIn'>;
  'providers.signOut': Handler<'providers.signOut'>;
} {
  return {
    'providers.authStatus': async ({ provider }) => {
      await accountEntry(provider);
      const signedIn = await auth.refresh(provider);
      return { signedIn, detail: signedIn ? auth.detail(provider) : null };
    },
    'providers.signIn': async ({ provider }) => {
      await accountEntry(provider);
      await auth.signIn(provider);
      return { ok: true };
    },
    'providers.signInInput': async ({ provider, data }) => {
      await accountEntry(provider);
      auth.input(provider, data);
      return { ok: true };
    },
    'providers.signInResize': async ({ provider, cols, rows }) => {
      await accountEntry(provider);
      auth.resize(provider, cols, rows);
      return { ok: true };
    },
    'providers.cancelSignIn': async ({ provider }) => {
      await accountEntry(provider);
      auth.cancel(provider);
      return { ok: true };
    },
    'providers.signOut': async ({ provider }) => {
      await accountEntry(provider);
      await auth.signOut(provider);
      return { ok: true };
    },
  };
}
