/**
 * Клиентский сертификат во встроенном браузере (SSO с mTLS): общие для main и рендерера формы запроса выбора.
 * Сертификат уходит сайту только по выбору человека (спека 2026-11-18-browser-client-certificate-design.md);
 * закрытый ключ Parley не видит — в окно идут лишь поля, нужные, чтобы человек узнал свой сертификат.
 */

/** Сертификат из списка запроса, как его видит человек. `fingerprint` — отпечаток Electron как есть (`sha256/…`). */
export interface ClientCertInfo {
  fingerprint: string;
  subjectName: string;
  issuerName: string;
  serialNumber: string;
  /** Секунды Unix. */
  validExpiry: number;
}

/**
 * Запрос окну: сайт просит сертификат (событие `browser:cert-request`). Идёт только окну-хозяину гостя.
 * `host` — `хост:порт` запроса; `pageHost` — `host` страницы гостя, когда он отличается (запрос от скрипта на другой порт
 * или поддомен), иначе `null`.
 */
export interface BrowserCertRequest {
  requestId: string;
  webContentsId: number;
  host: string;
  pageHost: string | null;
  certificates: ClientCertInfo[];
}

/** Отмена запроса main'ом (вкладка ушла со страницы или закрыта): окно убирает слой (`browser:cert-cancel`). */
export interface BrowserCertCancel {
  requestId: string;
  webContentsId: number;
}
