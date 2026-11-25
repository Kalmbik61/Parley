import { localClock, type SessionNeed } from '@parley/core/stuck';
import { createTranslator, defineCatalog, type AppLocale } from '@parley/core/i18n';

const reasons = defineCatalog(
  {
    approve: 'Waiting for your approval in its terminal',
    approvalDetail: 'Waiting for your approval: {detail}',
    question: 'Asked you a question in its terminal',
    limit: 'Hit its {provider} usage limit; {when}',
    reset: 'resets at {time}',
    unknownReset: 'the reset time is unknown',
    account: 'Account problem in {provider}',
    signedOut: 'Signed out of {provider}',
    signInDetail: '{reason}: {detail}',
    startup:
      'Waiting in its terminal since launch (sign-in, folder trust or another startup screen)',
  },
  {
    approve: 'Ждёт вашего разрешения в терминале',
    approvalDetail: 'Ждёт вашего разрешения: {detail}',
    question: 'Задал вам вопрос в терминале',
    limit: 'Достигнут лимит использования {provider} · {when}',
    reset: 'сброс в {time}',
    unknownReset: 'время сброса неизвестно',
    account: 'Проблема с аккаунтом в {provider}',
    signedOut: 'Выполнен выход из {provider}',
    signInDetail: '{reason}: {detail}',
    startup: 'Ждёт в терминале с момента запуска (вход, доверие к папке или другой экран запуска)',
  },
);

/** Подпись причины относится к Parley, подробности инструмента и имя провайдера приходят как данные. */
export function notificationReason(
  need: SessionNeed,
  now: Date,
  provider: string,
  locale: AppLocale,
): string {
  const t = createTranslator(locale, reasons);
  switch (need.kind) {
    case 'approval':
      return need.detail === null ? t('approve') : t('approvalDetail', { detail: need.detail });
    case 'question':
      return t('question');
    case 'limit': {
      if (need.resetsAt === null || Number.isNaN(Date.parse(need.resetsAt))) {
        return t('limit', { provider, when: t('unknownReset') });
      }
      const at = new Date(need.resetsAt);
      const time =
        locale === 'en'
          ? localClock(need.resetsAt, now)
          : at.toLocaleString(locale, {
              ...(at.toDateString() === now.toDateString()
                ? {}
                : { month: 'short', day: 'numeric' }),
              hour: '2-digit',
              minute: '2-digit',
            });
      return t('limit', { provider, when: t('reset', { time }) });
    }
    case 'sign-in': {
      const reason = t(need.account === 'account' ? 'account' : 'signedOut', { provider });
      return need.detail === null ? reason : t('signInDetail', { reason, detail: need.detail });
    }
    case 'startup':
      return t('startup');
  }
}
