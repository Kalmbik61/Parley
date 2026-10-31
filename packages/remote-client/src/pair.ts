// Паринг телефона (спека §7.3–7.4, §10.1): QR → relay `pair` → IKpsk0 → SAS → `credentials` → запись → `paired`.
import {
  FrameCodec,
  derivePairKeys,
  initiator,
  noblePrimitives,
  sas,
  type TransportCiphers,
} from '@parley/noise';
import {
  b64urlEncode,
  pairCredentialsFrame,
  pairMsg1Payload,
  pairMsg2Payload,
  parsePairUrl,
  relayUrlFor,
  type PairOffer,
} from '@parley/protocol/remote';
import type { HostRecord, HostStore } from './host-store.js';
import type { Platform } from './platform.js';
import { RelayError, RelayLink, type RelayErrorCode } from './relay-client.js';
import { decodeFrame, encodeFrame } from './rpc.js';

/** Ожидание msg2 после msg1 (§10.2: рукопожатие — 10 с). */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Ожидание `credentials` после показа SAS: человек решает на Маке до 120 с (§7.4). */
export const CREDENTIALS_TIMEOUT_MS = 120_000;
const PAIR_PROLOGUE = new TextEncoder().encode('parley-pair/1');
const PAIR_MAX_FRAME = 64 * 1024;
const EMPTY = new Uint8Array(0);

/**
 * - `bad_qr` — QR не разобран или relay с частным адресом в релизной сборке;
 * - `offer_closed` — relay не знает оффера (истёк, израсходован, кто-то успел первым);
 * - `relay` — другой отказ relay (`relayCode`), сигнал неаутентифицирован;
 * - `handshake` — msg2 не прочитан: чужой ключ хоста, порча, неверный payload; SAS не показан;
 * - `timeout` — нет `ready`, msg2 или `credentials` в срок;
 * - `denied` — после SAS мост закрыл поток без `credentials` (Deny, истечение на Маке);
 * - `connection` — труба оборвалась до msg2 или до отправки `paired`;
 * - `protocol` — неверный кадр внутри Noise; `storage` — запись хоста не сохранена; `cancelled` — отменён.
 */
export type PairErrorCode =
  | 'bad_qr'
  | 'offer_closed'
  | 'relay'
  | 'handshake'
  | 'timeout'
  | 'denied'
  | 'connection'
  | 'protocol'
  | 'storage'
  | 'cancelled';

export class PairError extends Error {
  readonly code: PairErrorCode;
  readonly relayCode: RelayErrorCode | null;
  constructor(code: PairErrorCode, relayCode: RelayErrorCode | null = null) {
    super(relayCode === null ? `pairing failed: ${code}` : `pairing failed: relay ${relayCode}`);
    this.name = 'PairError';
    this.code = code;
    this.relayCode = relayCode;
  }
}

export interface PairOptions {
  /** Имя телефона для окна Мака (payload msg1). */
  deviceName: string;
  /** `ios`, `android`… */
  platformName: string;
  /** Приложение и версия, например `parley-mobile/1.0.0`. */
  app: string;
  /** Код сверки — только после верного msg2 (§7.4). */
  onSas(code: string): void;
  signal?: AbortSignal;
}

/** `hostId = b64url(SHA-256("parley-host-v1" ‖ HS_pub)[0:16])` (§7.2). */
export function hostIdFor(hsPub: Uint8Array): string {
  const label = new TextEncoder().encode('parley-host-v1');
  const input = new Uint8Array(label.length + hsPub.length);
  input.set(label);
  input.set(hsPub, label.length);
  return b64urlEncode(noblePrimitives.hash(input).subarray(0, 16));
}

/** Паринг по QR. Запись хоста сохраняется до `{t:'paired'}`; результат — сохранённая запись. */
export async function pair(
  platform: Platform,
  store: HostStore,
  qrUrl: string,
  options: PairOptions,
): Promise<HostRecord> {
  // Имя телефона длиннее 64 знаков обрезается по кодовым точкам; `platformName` и `app` задаёт код приложения.
  let name = '';
  for (const ch of options.deviceName.trim()) {
    if (name.length + ch.length > 64) break;
    name += ch;
  }
  const payload = pairMsg1Payload.safeParse({
    v: 1,
    name: name || 'Phone',
    platform: options.platformName,
    app: options.app,
  });
  if (!payload.success) throw new PairError('protocol');
  const msg1Payload = encodeFrame(payload.data);
  let offer: PairOffer;
  let baseUrl: string;
  try {
    offer = parsePairUrl(qrUrl.trim());
    baseUrl = relayUrlFor(offer.r, { allowLocal: platform.allowLocalRelay });
  } catch {
    throw new PairError('bad_qr');
  }
  const { psk, lookup } = derivePairKeys(offer.s);
  const dsPriv = platform.random(32);
  const ds = { privateKey: dsPriv, publicKey: noblePrimitives.publicKey(dsPriv) };
  const hostId = hostIdFor(offer.k);

  const { signal } = options;
  if (signal?.aborted) throw new PairError('cancelled');
  const link = RelayLink.open(platform, baseUrl, { v: 1, t: 'pair', lookup: b64urlEncode(lookup) });
  const abort = (): void => link.close();
  signal?.addEventListener('abort', abort);
  let stage: 'relay' | 'handshake' | 'credentials' = 'relay';
  try {
    await link.ready;
    stage = 'handshake';
    const hs = initiator({ pattern: 'IKpsk0', prologue: PAIR_PROLOGUE, s: ds, rs: offer.k, psk });
    link.send(hs.writeMessage(msg1Payload));
    const msg2 = await link.receive(HANDSHAKE_TIMEOUT_MS);
    let ciphers: TransportCiphers;
    let sasCode: string;
    try {
      const payload = hs.readMessage(msg2);
      if (!pairMsg2Payload.safeParse(decodeFrame(payload)).success)
        throw new Error('bad msg2 payload');
      sasCode = sas(hs.handshakeHash());
      ciphers = hs.split();
    } catch {
      throw new PairError('handshake');
    }
    if (signal?.aborted) throw new PairError('cancelled');
    stage = 'credentials';
    options.onSas(sasCode);

    const codec = new FrameCodec({ maxFrame: PAIR_MAX_FRAME });
    const deadline = platform.now() + CREDENTIALS_TIMEOUT_MS;
    let frame: unknown = null;
    while (frame === null) {
      const message = await link.receive(Math.max(0, deadline - platform.now()));
      try {
        const chunk = codec.decode(ciphers.receive.decryptWithAd(EMPTY, message));
        if (chunk !== null) frame = decodeFrame(chunk);
      } catch {
        throw new PairError('protocol');
      }
    }
    const creds = pairCredentialsFrame.safeParse(frame);
    if (!creds.success || creds.data.hostId !== hostId) throw new PairError('protocol');

    const record: HostRecord = {
      hostId,
      hostName: creds.data.hostName,
      hsPub: b64urlEncode(offer.k),
      relay: offer.r,
      relays: creds.data.relays,
      routeId: creds.data.routeId,
      deviceId: creds.data.deviceId,
      relayToken: creds.data.relayToken,
      dsPriv: b64urlEncode(ds.privateKey),
      dsPub: b64urlEncode(ds.publicKey),
      lastTs: 0,
      pairedAt: platform.now(),
    };
    if (signal?.aborted) throw new PairError('cancelled');
    // Повторный паринг с тем же Маком: прежняя запись рабочая, пока мост не принял новое устройство (m10).
    let previous: HostRecord | null;
    try {
      previous = await store.get(hostId);
      await store.put(record);
    } catch {
      throw new PairError('storage');
    }
    try {
      for (const plaintext of codec.encode(encodeFrame({ t: 'paired' }))) {
        link.send(ciphers.send.encryptWithAd(EMPTY, plaintext));
      }
    } catch {
      // Мост без `paired` удалит устройство через 30 с — запись телефона тогда бесполезна.
      await restore(store, record, previous).catch(() => undefined);
      throw new PairError('connection');
    }
    return record;
  } catch (error) {
    if (error instanceof PairError) throw error;
    if (signal?.aborted) throw new PairError('cancelled');
    throw mapLinkError(error, stage);
  } finally {
    signal?.removeEventListener('abort', abort);
    link.close();
  }
}

/**
 * Откат неудачного паринга: прежняя запись хоста возвращается, иначе запись удаляется. Если прежнее устройство
 * успело подключиться поверх новой записи, `lastTs` берётся наибольший — метки подключения не идут назад.
 */
async function restore(store: HostStore, record: HostRecord, previous: HostRecord | null): Promise<void> {
  if (previous === null) return store.remove(record.hostId);
  const current = await store.get(record.hostId);
  const lastTs = Math.max(previous.lastTs, current?.lastTs ?? 0);
  return store.put({ ...previous, lastTs });
}

function mapLinkError(error: unknown, stage: 'relay' | 'handshake' | 'credentials'): PairError {
  if (!(error instanceof RelayError)) return new PairError('protocol');
  if (error.relayCode === 'offer_closed') return new PairError('offer_closed');
  if (error.relayCode !== null) return new PairError('relay', error.relayCode);
  if (error.code === 'timeout') return new PairError('timeout');
  if (error.code === 'protocol') return new PairError('protocol');
  if (stage === 'credentials') return new PairError('denied');
  return new PairError('connection');
}
