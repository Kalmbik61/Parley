/* global require, performance */
/* eslint-disable @typescript-eslint/no-require-imports -- Injected verbatim into Electron's sandboxed CommonJS preload. */
(function () {
  const { ipcRenderer: ipc, contextBridge } = require('electron');
  const samples = [], listeners = new WeakMap();
  const observe = process.env.P7_OBSERVE !== '0';
  let enabled = observe, dropped = 0, legacy = 0;
  const now = () => performance.timeOrigin + performance.now();
  const record = data => { if (!enabled) return; if (samples.length < 100000) samples.push(data); else dropped += 1; };
  const on = ipc.on, remove = ipc.removeListener, send = ipc.send;
  if (observe) ipc.on = function (channel, listener) {
    if (channel !== 'works-sync:batch' && channel !== 'host:event') return Reflect.apply(on, this, [channel, listener]);
    const wrapped = function (...args) {
      const start = now();
      const relevant = channel === 'works-sync:batch' || args[1]?.event === 'works.changed';
      try { return Reflect.apply(listener, this, args); }
      finally { if (relevant) record({ phase: 'ipc-receive-consumer', at: start, ms: now() - start, channel, stream: channel === 'works-sync:batch' ? args[1] : null, delivery: channel === 'works-sync:batch' ? args[2] : ++legacy }); }
    };
    let channels = listeners.get(listener);
    if (!channels) { channels = new Map(); listeners.set(listener, channels); }
    let registrations = channels.get(channel);
    if (!registrations) { registrations = []; channels.set(channel, registrations); }
    registrations.push(wrapped);
    return Reflect.apply(on, this, [channel, wrapped]);
  };
  if (observe) {
    ipc.removeListener = function (channel, listener) {
      const channels = listeners.get(listener), registrations = channels?.get(channel);
      const wrapped = registrations?.pop() ?? listener;
      if (registrations?.length === 0) channels.delete(channel);
      return Reflect.apply(remove, this, [channel, wrapped]);
    };
    ipc.off = ipc.removeListener;
    ipc.send = function (channel, ...args) { if (channel === 'works-sync:ack') record({ phase: 'ipc-ack-send', at: now(), stream: args[0], delivery: args[1] }); return Reflect.apply(send, this, [channel, ...args]); };
  }
  contextBridge.exposeInMainWorld('__p7Observe', observe);
  contextBridge.exposeInMainWorld('__p7CommitProbe', process.env.P7_COMMIT_PROBE !== '0');
  contextBridge.exposeInMainWorld('__p7IPC', { reset() { samples.length = 0; dropped = 0; legacy = 0; enabled = observe; }, read() { enabled = false; return { samples, dropped }; } });
})();
