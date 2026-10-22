import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import { accountEntry } from '../providers/auth-service.js';
import type { AuthService } from '../providers/auth-service.js';

/** Вход этого аккаунта не идёт: ввод, размер и отмена принимать некому (`bad_request`, спека подписок 5.5). */
function requireSignIn(auth: AuthService, provider: string): void {
  if (!auth.signingIn(provider)) throw new HostError('bad_request', `no sign-in is running for ${provider}`);
}

/**
 * Шесть методов входа в аккаунт подписки (спека подписок 5.5, К14): состояние, вход в своём маленьком PTY, ввод кода
 * из браузера, размер терминала, отмена и выход. Состояние, вход и выход берут аккаунт из реестра: встроенный `claude`,
 * GLM, свой провайдер с адресом и неизвестный id получают `bad_request` (`<id> is not an account`). Ввод, размер и
 * отмена реестр не читают: им нужен идущий вход этого id, иначе `bad_request` (`no sign-in is running for <id>`). Вывод
 * и выход процесса входа окно получает событиями `providers.signInOutput` и `providers.signInExit`, не ответом.
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
    // Ввод, размер и отмена не читают реестр: замок службы входа держит только аккаунт (`signingIn`), а await перед
    // `auth.input` пустил бы два быстрых нажатия в разном порядке. Обработчик отрабатывает синхронно, как пришёл запрос.
    'providers.signInInput': async ({ provider, data }) => {
      requireSignIn(auth, provider);
      auth.input(provider, data);
      return { ok: true };
    },
    'providers.signInResize': async ({ provider, cols, rows }) => {
      requireSignIn(auth, provider);
      auth.resize(provider, cols, rows);
      return { ok: true };
    },
    'providers.cancelSignIn': async ({ provider }) => {
      requireSignIn(auth, provider);
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
