import { useEffect, useRef, useState } from 'react';
import { roomHistoryStatus } from '@parley/protocol';
import type { RoomHistoryStatusView } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';

const H = S.roomHistory;
type Action = 'share' | 'unshare';
export interface RoomHistoryMenuProps {
  projectPath: string;
  workId: string;
  roomId: string;
  bridge: ParleyBridge;
}

/**
 * Share и Unshare истории комнаты (спека памяти и журнала, 4.3, 8). Состояние читает хост (`rooms.history.get`),
 * окно ему на слово не верит. Share публикует снимок в общие файлы git — только после явного подтверждения;
 * отмена ничего не меняет. Ответы, пришедшие после смены комнаты, подключения, моста или набора методов хоста,
 * отбрасываются вместе с неподтверждённым запросом.
 */
export function RoomHistoryMenu({ projectPath, workId, roomId, bridge }: RoomHistoryMenuProps): JSX.Element {
  const hostStatus = useHostStore(state => state.status);
  const connections = useHostStore(state => state.connections);
  const methods = hostMethods(hostStatus);
  const supported = ['rooms.history.get', 'rooms.history.share', 'rooms.history.unshare'].every(name => methods.has(name));
  const connected = hostStatus.state === 'connected';
  const identity = [projectPath, workId, roomId, connections, hostStatus.state, supported].join('\0');
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const currentBridge = useRef(bridge); currentBridge.current = bridge;
  const generation = useRef(0);
  // Номер последнего чтения: ответ более раннего чтения, пришедший позже, не применяется.
  const readSeq = useRef(0);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RoomHistoryStatusView | null>(null);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [reload, setReload] = useState(0);

  // Любая смена личности запроса: ответы старой личности и неподтверждённая публикация уходят.
  useEffect(() => {
    ++generation.current;
    setStatus(null); setReading(false); setReadFailed(false); setConfirm(null); setBusy(false); setFeedback(null); setDiagnostics([]);
    return () => { ++generation.current; };
  }, [identity, bridge]);

  const alive = (token: number, captured: string): boolean =>
    generation.current === token && currentIdentity.current === captured && currentBridge.current === bridge;

  // Чтение только когда меню открыто: закрытое меню хост не трогает.
  useEffect(() => {
    if (!open || !supported || !connected) return;
    const token = generation.current; const captured = identity; const seq = ++readSeq.current;
    const latest = (): boolean => alive(token, captured) && readSeq.current === seq;
    setReading(true); setReadFailed(false);
    void bridge.call('rooms.history.get', { projectPath, workId, roomId }).then(value => {
      if (!latest()) return;
      const parsed = roomHistoryStatus.safeParse(value);
      if (parsed.success) setStatus(parsed.data); else { setStatus(null); setReadFailed(true); }
    }).catch(() => {
      if (latest()) { setStatus(null); setReadFailed(true); }
    }).finally(() => { if (latest()) setReading(false); });
  }, [open, supported, connected, identity, bridge, reload]);

  const run = async (action: Action): Promise<void> => {
    if (busy || status === null || confirm !== action || !supported || !connected) return;
    const token = generation.current; const captured = identity;
    setBusy(true); setFeedback(null);
    try {
      const base = { projectPath, workId, roomId, expectedVersion: status.version };
      const value = action === 'share'
        ? await bridge.call('rooms.history.share', { ...base, confirmed: true })
        : await bridge.call('rooms.history.unshare', base);
      if (!alive(token, captured)) return;
      const parsed = roomHistoryStatus.safeParse(value);
      if (!parsed.success) throw new Error('invalid history answer');
      setStatus(parsed.data); setConfirm(null); setDiagnostics(parsed.data.diagnostics.map(row => row.code));
    } catch (error) {
      if (!alive(token, captured)) return;
      // Ошибка видна, а «shared at» не выдумывается: состояние читается у хоста заново.
      setConfirm(null); setStatus(null); setReload(value => value + 1);
      setFeedback(decodeIpcError(error).code === 'conflict' ? H.changed : action === 'share' ? H.shareFailed : H.unshareFailed);
    } finally { if (alive(token, captured)) setBusy(false); }
  };

  // Закрытие (Escape, клик вне, повторный клик) снимает неподтверждённое: после повторного открытия Share снова явный.
  const changeOpen = (next: boolean): void => { setOpen(next); if (!next) { setConfirm(null); setFeedback(null); } };

  const shared = status?.state === 'shared';
  // Панель всплывает поверх ленты: шапка комнаты от раскрытия не растёт, длинное содержимое прокручивается внутри панели.
  return <div data-room-history="" className="flex items-center gap-2 text-xs">
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline">{H.menu}</Button>
      </PopoverTrigger>
      <PopoverContent role="group" aria-label={H.menu} align="start" collisionPadding={8}
        className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] space-y-2 overflow-y-auto text-xs">
        {!connected ? <p role="status">{H.disconnected}</p>
          : !supported ? <p role="status">{H.unavailable}</p>
            : <>
              {reading && status === null && <p role="status">{H.loading}</p>}
              {readFailed && <p role="alert" className="text-destructive">{H.loadFailed}</p>}
              {status !== null && <p role="status">{shared && status.sharedAt !== null ? H.sharedAt(status.sharedAt) : status.state === 'conflict' ? H.conflict : H.notShared}</p>}
              {diagnostics.map(code => <p key={code} role="status">{H.ignore[code as keyof typeof H.ignore]}</p>)}
              {feedback !== null && <p role="alert" className="text-destructive">{feedback}</p>}
              {confirm === null ? <div className="flex flex-wrap gap-2">
                {status !== null && status.state !== 'conflict' && <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm('share')}>{shared ? H.reshare : H.share}</Button>}
                {shared && <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm('unshare')}>{H.unshare}</Button>}
                <Button type="button" variant="outline" disabled={reading || busy} onClick={() => setReload(value => value + 1)}>{H.refresh}</Button>
              </div> : <div className="space-y-2">
                <p>{confirm === 'share' ? H.shareWarning : H.unshareWarning}</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={busy} onClick={() => void run(confirm)}>{confirm === 'share' ? H.confirmShare : H.confirmUnshare}</Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(null)}>{S.common.cancel}</Button>
                </div>
              </div>}
            </>}
      </PopoverContent>
    </Popover>
  </div>;
}
