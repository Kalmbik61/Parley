/**
 * Remote access: types shared by main and the renderer (mobile spec 12, plan A10).
 * The window talks only to the local control socket of the bridge — never through the relay.
 */

/** `status` of the control socket (spec 5.3). */
export interface RemoteBridgeStatus {
  running: boolean;
  host: 'starting' | 'online' | 'offline' | 'incompatible';
  relay: 'connected' | 'connecting' | 'error';
  relayUrl: string | null;
  devices: number;
  version: string;
}

/** State of the bridge as the window sees it. `error` carries a short English reason. */
export interface RemoteState {
  enabled: boolean;
  process: 'off' | 'starting' | 'running' | 'error';
  error: string | null;
  status: RemoteBridgeStatus | null;
}

export interface RemoteDevice {
  deviceId: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number | null;
}

export interface RemoteAuditRecord {
  at: string;
  deviceId: string;
  deviceName: string;
  kind: string;
  method?: string;
  target?: string;
  outcome: string;
  detail?: string;
}

/** `pair.start` as the renderer gets it: the QR is already an image, the raw string stays in main. */
export interface RemotePairOffer {
  qr: string;
  expiresAt: number;
}

export interface RemotePairRequest {
  requestId: string;
  name: string;
  platform: string;
  sas: string;
  fingerprint: string;
  expiresAt: number;
}

/** Methods the renderer may call through `remote:call`. */
export interface RemoteCalls {
  state: { params: Record<string, never>; result: RemoteState };
  setEnabled: { params: { enabled: boolean }; result: RemoteState };
  configure: { params: { relayUrl: string }; result: RemoteState };
  'pair.start': { params: Record<string, never>; result: RemotePairOffer };
  'pair.cancel': { params: Record<string, never>; result: null };
  'pair.answer': { params: { requestId: string; allow: boolean }; result: null };
  'devices.list': { params: Record<string, never>; result: RemoteDevice[] };
  'devices.revoke': { params: { deviceId: string }; result: null };
  reset: { params: Record<string, never>; result: null };
  'audit.tail': { params: { limit: number }; result: RemoteAuditRecord[] };
}
export type RemoteCallName = keyof RemoteCalls;
export const REMOTE_CALL_NAMES: readonly RemoteCallName[] = [
  'state',
  'setEnabled',
  'configure',
  'pair.start',
  'pair.cancel',
  'pair.answer',
  'devices.list',
  'devices.revoke',
  'reset',
  'audit.tail',
];

/** Events main forwards to the renderer on `remote:event`. */
export type RemoteEvent =
  | { event: 'state'; data: RemoteState }
  | { event: 'pair.request'; data: RemotePairRequest }
  | { event: 'pair.done'; data: { requestId: string; deviceId: string } }
  | { event: 'pair.failed'; data: { requestId: string; reason: string } }
  | { event: 'pair.offerClosed'; data: { reason: 'bad-psk' | 'used' } };
