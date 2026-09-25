import { useEffect, useState } from 'react';
import { getHostClient } from './host-client.js';
import type { HostStatus } from '../shared/bridge.js';

/**
 * Черновая оболочка окна для куска 1.9: статус связи с хостом и пустой
 * список работ. Сайдбар, дерево сессий и терминал — куски 1.10 и 1.11.
 */
export function App(): JSX.Element {
  const [status, setStatus] = useState<HostStatus>({ state: 'connecting' });
  const [chooseError, setChooseError] = useState<string | null>(null);

  useEffect(() => getHostClient().onStatus(setStatus), []);

  const handleNewWork = async (): Promise<void> => {
    setChooseError(null);
    try {
      const dir = await getHostClient().app.chooseFolder();
      if (dir === null) return;
      await getHostClient().call('works.create', { projectPath: dir, title: 'Новая работа', goal: '' });
    } catch (err) {
      setChooseError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRestart = (): void => {
    void getHostClient().app.restartHost();
  };

  if (status.state === 'mismatch') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 text-neutral-200">
        <p>Хост старой версии. Перезапустить? Живых сессий: {status.liveSessions ?? '—'}.</p>
        <button type="button" className="rounded bg-neutral-700 px-4 py-2" onClick={handleRestart}>
          Перезапустить
        </button>
      </div>
    );
  }

  if (status.state === 'connecting') {
    return <div className="flex h-screen items-center justify-center text-neutral-400">Подключение к хосту…</div>;
  }

  if (status.state === 'disconnected') {
    return (
      <div className="flex h-screen items-center justify-center text-neutral-400">
        Нет связи с хостом: {status.reason}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 text-neutral-200">
      <p>Работ пока нет</p>
      <button type="button" className="rounded bg-neutral-700 px-4 py-2" onClick={() => void handleNewWork()}>
        Новая работа
      </button>
      {chooseError !== null ? <p className="text-red-400">{chooseError}</p> : null}
    </div>
  );
}
