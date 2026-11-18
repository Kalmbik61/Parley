/**
 * Выбор клиентского сертификата над вкладкой браузера (`browser:cert-request`, SSO с mTLS): не нативный диалог и не alert, а
 * слой поверх поля страницы, как `AuthPrompt`. Первым выбран первый сертификат, но кнопку нажимает человек. «Not now» и Esc —
 * не отказ сайту, а «не сейчас»: main забывает запрос, сайт спросит при следующей попытке. Ответ — отпечаток и галочка
 * «запомнить для сайта»; сам сертификат и ключ в окно не приходят. Карточка в 800×500 помещается и с длинным именем
 * субъекта: оно переносится, а сама карточка прокручивается внутри слоя.
 */

import { useEffect, useRef, useState } from 'react';
import type { BrowserCertRequest } from '../../shared/client-cert.js';
import { S } from '../../shared/strings.js';

export interface CertPromptProps {
  request: BrowserCertRequest;
  /** Ответ не дошёл до main (мост отказал): запрос остаётся на экране, под заголовком — строка ошибки. */
  failed?: boolean;
  /** Отпечаток выбранного сертификата и «запомнить» или `null` — «не сейчас». */
  onSubmit(answer: { fingerprint: string; remember: boolean } | null): void;
}

export function CertPrompt({ request, failed = false, onSubmit }: CertPromptProps): JSX.Element {
  const [selected, setSelected] = useState(0);
  const [remember, setRemember] = useState(false);
  const radios = useRef<Array<HTMLInputElement | null>>([]);

  // Новый запрос — выбор и галочка сброшены, фокус на выбранном сертификате.
  useEffect(() => {
    setSelected(0);
    setRemember(false);
    radios.current[0]?.focus();
  }, [request.requestId]);

  const chosen = request.certificates[selected] ?? request.certificates[0];

  return (
    <div data-testid="browser-cert" className="absolute inset-0 z-30 flex items-start justify-center overflow-auto bg-background/90 p-4">
      <form
        role="dialog"
        aria-label={S.browser.cert.title(request.host)}
        className="my-auto flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 text-sm text-card-foreground shadow-lg"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen !== undefined) onSubmit({ fingerprint: chosen.fingerprint, remember });
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onSubmit(null);
        }}
      >
        <div className="flex flex-col gap-1">
          <div data-testid="browser-cert-host" className="break-all font-medium">
            {S.browser.cert.title(request.host)}
          </div>
          {request.pageHost === null ? null : <div className="break-all text-xs text-muted-foreground">{S.browser.cert.requestedBy(request.pageHost)}</div>}
        </div>
        {failed ? (
          <div role="alert" className="text-xs text-destructive">
            {S.browser.cert.sendFailed}
          </div>
        ) : null}
        <div role="radiogroup" aria-label={S.browser.cert.title(request.host)} className="flex flex-col gap-1.5">
          {request.certificates.map((cert, index) => (
            <label
              key={cert.fingerprint}
              className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${index === selected ? 'border-ring bg-accent' : 'border-border'}`}
            >
              <input
                ref={(node) => {
                  radios.current[index] = node;
                }}
                type="radio"
                name={`cert-${request.requestId}`}
                checked={index === selected}
                onChange={() => setSelected(index)}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="break-all">{cert.subjectName}</span>
                <span className="break-all text-[11px] text-muted-foreground">{S.browser.cert.issuer(cert.issuerName)}</span>
                <span className="text-[11px] text-muted-foreground">{S.browser.cert.expires(new Date(cert.validExpiry * 1000).toLocaleDateString())}</span>
                <span className="break-all text-[11px] text-muted-foreground">{S.browser.cert.serial(cert.serialNumber)}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="mt-0.5" />
          <span>{S.browser.cert.remember}</span>
        </label>
        <div className="text-xs text-muted-foreground">{S.browser.cert.keyAccess}</div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onSubmit(null)} className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent">
            {S.browser.cert.notNow}
          </button>
          <button type="submit" className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90">
            {S.browser.cert.use}
          </button>
        </div>
      </form>
    </div>
  );
}
