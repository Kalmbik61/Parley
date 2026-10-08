/**
 * Детали запроса панели Network (спека 2026-10-07-browser-devtools-agent-design.md, 4.4).
 * - Headers — General (URL, метод, статус, удалённый адрес), заголовки ответа и запроса.
 * - Payload — query по параметрам; тело: JSON — отформатированным, form — по полям, бинарное — размером.
 * - Response — по клику через `responseBody`, до 1 МБ: JSON отформатированным, текст как есть, бинарное — размером
 *   и типом. Вытесненное Chromium тело — «Body is no longer available».
 * Заголовки и тела — как есть: это браузер человека. Маска — только для «Add to chat» и агента (этапы B, C).
 */
import { X } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { DEVTOOLS_LIMITS, type NetworkEntry, type ResponseBody } from '../../../shared/browser-devtools.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { PanelIconButton } from './controls.js';
import { base64Bytes, formFields, headerValue, prettyJson, queryParams, statusCell } from './format.js';

type DetailsView = 'headers' | 'payload' | 'response';
type BodyState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'gone' } | { kind: 'loaded'; body: ResponseBody };

/** Тело запроса бинарное — показывается только размер (спека 4.4). */
const BINARY_TYPE = /^(image|audio|video|font)\/|octet-stream|application\/(pdf|zip|wasm)/i;
const TRIGGER = 'px-2 py-0.5 text-[11px]';
const CONTENT = 'mt-0 min-h-0 flex-1 overflow-auto p-2 text-[11px]';
const ACTION = 'h-5 shrink-0 rounded px-1.5 text-[11px] text-foreground hover:bg-accent';

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-2">
      <h3 className="mb-1 font-medium text-foreground">{title}</h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function Pair({ name, value }: { name: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 gap-2 break-all font-mono">
      <span className="shrink-0 text-foreground">{name}:</span>
      <span className="min-w-0 text-muted-foreground">{value}</span>
    </div>
  );
}

function Pairs({ pairs }: { pairs: ReadonlyArray<[string, string]> }): JSX.Element {
  return (
    <>
      {pairs.map(([name, value], index) => (
        <Pair key={`${name}-${index}`} name={name} value={value} />
      ))}
    </>
  );
}

/** Запрос закончился: `loadingFinished` ставит размер и длительность, `loadingFailed` — отказ и длительность (inspector.ts). */
function isFinished(entry: NetworkEntry): boolean {
  return entry.failure !== null || entry.durationMs !== null || entry.encodedBytes !== null;
}

function statusLine(entry: NetworkEntry): string {
  if (entry.failure !== null) return `${statusCell(entry).text} ${entry.failure.text}`.trim();
  if (entry.status === null) return statusCell(entry).text;
  return `${entry.status} ${entry.statusText}`.trim();
}

function ResponseView({ entry, body }: { entry: NetworkEntry; body: ResponseBody }): JSX.Element {
  // Деталь перерисовывается с каждой пачкой журнала: тело до 1 МБ не разбирается заново, пока оно то же.
  const text = useMemo(() => (body.base64 ? '' : (prettyJson(body.text) ?? body.text)), [body.base64, body.text]);
  if (body.base64) {
    // Обрезанное тело своего размера не знает — берётся размер ответа из журнала.
    const bytes = body.truncated ? (entry.encodedBytes ?? base64Bytes(body.text)) : base64Bytes(body.text);
    return <p data-testid="response-body">{S.browser.devtools.details.binary(S.browser.devtools.bytes(bytes), entry.mimeType ?? '')}</p>;
  }
  return (
    <>
      {body.truncated ? (
        <p className="mb-1 text-muted-foreground">{S.browser.devtools.details.truncated(S.browser.devtools.bytes(DEVTOOLS_LIMITS.panelBody))}</p>
      ) : null}
      <pre data-testid="response-body" className="whitespace-pre-wrap break-all font-mono">
        {text}
      </pre>
    </>
  );
}

export interface RequestDetailsProps {
  entry: NetworkEntry;
  webContentsId: number | null;
  bridge: ParleyBridge;
  onClose(): void;
  /** «Add to chat» запроса — этап B (спека 4.4, 4.5); нет колбэка — нет кнопки. */
  onAddToChat?: ((entry: NetworkEntry) => void) | undefined;
}

export function RequestDetails({ entry, webContentsId, bridge, onClose, onAddToChat }: RequestDetailsProps): JSX.Element {
  const [view, setView] = useState<DetailsView>('headers');
  const [body, setBody] = useState<BodyState>({ kind: 'idle' });
  // Другой запрос — свои вкладка и тело. Закончившийся запрос — тело заново: пока шёл, main отвечал null («gone»).
  // Поздний ответ прежнего запроса или прежнего состояния отбрасывается.
  const finished = isFinished(entry);
  const [shown, setShown] = useState({ id: entry.id, finished });
  const current = useRef(shown);
  current.current = { id: entry.id, finished };
  if (shown.id !== entry.id || shown.finished !== finished) {
    setShown({ id: entry.id, finished });
    if (shown.id !== entry.id) setView('headers');
    setBody({ kind: 'idle' });
  }

  const loadBody = (): void => {
    if (webContentsId === null) return;
    const requestId = entry.id;
    const stale = (): boolean => current.current.id !== requestId || current.current.finished !== finished;
    setBody({ kind: 'loading' });
    bridge.browser.responseBody(webContentsId, requestId).then(
      (result) => {
        if (!stale()) setBody(result === null ? { kind: 'gone' } : { kind: 'loaded', body: result });
      },
      (error: unknown) => {
        if (stale()) return;
        console.error('[parley] responseBody failed', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.loadResponse));
        setBody({ kind: 'idle' });
      },
    );
  };

  const copyUrl = (): void => {
    navigator.clipboard.writeText(entry.url).catch((error: unknown) => console.warn('[parley] clipboard', error));
  };

  const details = S.browser.devtools.details;
  const query = queryParams(entry.url);
  const contentType = headerValue(entry.requestHeaders, 'content-type') ?? '';
  const payload = entry.postData;

  return (
    <div data-testid="request-details" className="flex h-full min-h-0 flex-col">
      <Tabs
        value={view}
        onValueChange={(next) => {
          const value: DetailsView = next === 'payload' || next === 'response' ? next : 'headers';
          setView(value);
          // Тело грузится по клику (спека 4.4): вкладка Response — тот самый клик.
          if (value === 'response' && body.kind === 'idle') loadBody();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <TabsList className="h-6 p-0.5">
            <TabsTrigger value="headers" className={TRIGGER}>
              {details.headers}
            </TabsTrigger>
            <TabsTrigger value="payload" className={TRIGGER}>
              {details.payload}
            </TabsTrigger>
            <TabsTrigger value="response" className={TRIGGER}>
              {details.response}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onAddToChat === undefined ? null : (
              <button type="button" onClick={() => onAddToChat(entry)} className={ACTION}>
                {S.browser.devtools.addToChat}
              </button>
            )}
            <button type="button" onClick={copyUrl} className={ACTION}>
              {details.copyUrl}
            </button>
            <PanelIconButton label={details.close} onClick={() => onClose()}>
              <X className="size-3" aria-hidden="true" />
            </PanelIconButton>
          </div>
        </div>
        <TabsContent value="headers" className={CONTENT}>
          <Section title={details.general}>
            <Pair name={details.url} value={entry.url} />
            <Pair name={details.method} value={entry.method} />
            <Pair name={details.status} value={statusLine(entry)} />
            {entry.remoteAddress === null ? null : <Pair name={details.remoteAddress} value={entry.remoteAddress} />}
          </Section>
          <Section title={details.responseHeaders}>
            <Pairs pairs={entry.responseHeaders} />
          </Section>
          <Section title={details.requestHeaders}>
            <Pairs pairs={entry.requestHeaders} />
          </Section>
        </TabsContent>
        <TabsContent value="payload" className={CONTENT}>
          {query.length === 0 && payload === null ? <p className="text-muted-foreground">{details.noPayload}</p> : null}
          {query.length === 0 ? null : (
            <Section title={details.query}>
              <Pairs pairs={query} />
            </Section>
          )}
          {payload === null ? null : (
            <Section title={details.body}>
              {BINARY_TYPE.test(contentType) ? (
                <p>{details.binary(S.browser.devtools.bytes(payload.length), contentType)}</p>
              ) : contentType.includes('application/x-www-form-urlencoded') ? (
                <Pairs pairs={formFields(payload)} />
              ) : (
                <pre data-testid="request-body" className="whitespace-pre-wrap break-all font-mono">
                  {prettyJson(payload) ?? payload}
                </pre>
              )}
            </Section>
          )}
        </TabsContent>
        <TabsContent value="response" className={CONTENT}>
          {body.kind === 'idle' ? (
            <button type="button" onClick={loadBody} className="rounded border border-border px-2 py-0.5 hover:bg-accent">
              {details.loadResponse}
            </button>
          ) : null}
          {body.kind === 'loading' ? <p className="text-muted-foreground">{details.loading}</p> : null}
          {body.kind === 'gone' ? (
            <p data-testid="response-gone" className="text-muted-foreground">
              {details.bodyGone}
            </p>
          ) : null}
          {body.kind === 'loaded' ? <ResponseView entry={entry} body={body.body} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
