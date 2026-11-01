// Contract between A7 (Noise sessions, sessions.ts) and A8 (application layer). Types only.
// Frames are the UTF-8 JSON bytes of one application frame, both ways; A8 parses and serializes JSON.
// Chunking, deflate (FrameCodec) and encryption live in A7. The inbound 64 KiB ceiling is enforced by A7.
import type { BridgeHello } from '@parley/protocol/remote';

export type SessionClosingReason = 'revoked' | 'reset' | 'rekey' | 'replaced' | 'shutdown' | 'slow' | 'protocol';

export interface DevicePush {
  apnsToken: string;
  env: 'sandbox' | 'production';
}

/** A7 → A8. */
export interface PhoneSessions {
  /** Encrypts and sends one frame; `false` when the device has no confirmed session. */
  send(deviceId: string, frame: Uint8Array): boolean;
  /** Sends `session.closing {reason}` inside Noise, then closes the session. No-op without a session. */
  close(deviceId: string, reason: SessionClosingReason): void;
  /** Bytes queued on the device's socket (WebSocket `bufferedAmount`); 0 without a session. */
  bufferedBytes(deviceId: string): number;
  /** Stores the push token in devices.json (atomic write); `null` clears it. */
  setPush(deviceId: string, push: DevicePush | null): Promise<void>;
}

/** A8 → A7. */
export interface SessionHandler {
  /** Payload of msg2 of a connection handshake (spec §8.2). */
  hello(deviceId: string): BridgeHello;
  /** The session is confirmed by its first valid transport frame; `send` works from here on. */
  onOpen(deviceId: string): void;
  /** Every frame of a confirmed session, the confirming one included (after `onOpen`). */
  onFrame(deviceId: string, frame: Uint8Array): void;
  /** The confirmed session ended (any reason). Not called for sessions that were never confirmed. */
  onClose(deviceId: string): void;
}
