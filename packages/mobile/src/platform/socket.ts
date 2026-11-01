// WebSocket opener. The release build accepts only `wss://`; `ws://` is for a private-address relay in a developer
// build (spec §6.6). The check runs before the socket constructor, so a refused address never opens a connection.
import { isPrivateRelayHost } from '@parley/protocol/remote';
import type { WebSocketLike } from '@parley/remote-client';

export type SocketConstructor = new (url: string) => WebSocketLike;

export function createOpenSocket(
  Socket: SocketConstructor,
  allowLocal: boolean,
): (url: string) => WebSocketLike {
  return (url) => {
    const m = /^(wss?):\/\/([^/?#]+)(?:\/[^?#]*)?$/.exec(url);
    if (m === null) throw new Error('socket: unsupported relay url');
    if (m[1] === 'ws' && !(allowLocal && isPrivateRelayHost(m[2]!))) {
      throw new Error('socket: ws:// is not allowed in this build');
    }
    return new Socket(url);
  };
}
