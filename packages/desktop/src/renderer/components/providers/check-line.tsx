/** Строка исхода проверки ключа и её помощники: общие для ProviderCard (GLM) и формы своего провайдера (спека своих провайдеров, 4.3). */
import { PROVIDER_CHECK_REASONS, type ProviderCheck, type ProviderCheckReason } from '@parley/protocol';
import { S } from '../../../shared/strings.js';

/** Даже неполный/чужой ответ хоста не должен отразить немаскированную строку. */
export function maskedHint(hint: string): string {
  return /^[•*]+[^•*]{0,4}$/u.test(hint) ? `••••${hint.replace(/^[•*]+/u, '')}` : '••••';
}

/**
 * Время проверки — местное и короткое, как в тултипе лимитов строки статуса: «9:30 PM». Исход переживает
 * перезапуск хоста, поэтому не сегодняшняя проверка показывает и дату: «Oct 5, 9:30 PM».
 */
export function clock(iso: string, now = new Date()): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Причина, которую знает это окно: незнакомая (хост новее окна) читается как «незнакомый ответ». */
export const knownReason = (reason: string | undefined): ProviderCheckReason =>
  (PROVIDER_CHECK_REASONS as readonly (string | undefined)[]).includes(reason)
    ? (reason as ProviderCheckReason)
    : 'unsupported_response';

/** Из двух исходов — более поздний: ответ этой карточки или снимок списка (его могло обновить другое окно). */
export function newerCheck(answer: ProviderCheck | null, snapshot: ProviderCheck | null): ProviderCheck | null {
  if (answer === null) return snapshot;
  if (snapshot === null) return answer;
  return Date.parse(snapshot.at) > Date.parse(answer.at) ? snapshot : answer;
}

/** Строка исхода проверки ключа: «проверено» или подсказка, что делать, и подробности ответа Z.ai. */
export function CheckLine({
  check,
  checking,
  custom = false,
}: {
  check: ProviderCheck | null;
  checking: boolean;
  /** Своя проверка (не Z.ai): тексты без названия вендора. */
  custom?: boolean;
}): JSX.Element | null {
  if (!checking && check === null) return null;
  return (
    <div role="status" aria-busy={checking} className="space-y-0.5 text-xs">
      {checking || check === null ? (
        <p className="text-muted-foreground">{custom ? S.customProviders.checkingLine : S.providerCard.checkingLine}</p>
      ) : check.state === 'ok' ? (
        <p className="text-muted-foreground">{S.providerCard.checkedOk(clock(check.at))}</p>
      ) : (
        <>
          <p className="text-destructive">{(custom ? S.customProviders.checkHint : S.providerCard.checkHint)[knownReason(check.reason)]}</p>
          <p className="tabular-nums text-muted-foreground">
            {S.providerCard.checkDetails(check.httpStatus, check.code, clock(check.at))}
          </p>
        </>
      )}
    </div>
  );
}

