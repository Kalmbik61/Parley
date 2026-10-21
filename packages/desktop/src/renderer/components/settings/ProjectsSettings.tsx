/**
 * Settings → Projects (спека 2026-10-21, 4.1): папки, которым человек выдал согласие для агентов (`trust.json`
 * хоста). У каждой — дата, откуда выдано (окно, остров, Telegram) и кнопка Revoke: `trust.revoke` убирает запись,
 * отзыв действует на следующий запуск, живые сессии не трогаются. Список всегда перечитывается у хоста.
 */
import { useCallback, useEffect, useState } from 'react';
import type { TrustRecord } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { shortenMiddle } from '../../lib/shorten-middle.js';
import { Button } from '../../ui/button.js';

export interface ProjectsSettingsProps {
  bridge: ParleyBridge;
}

export function ProjectsSettings({ bridge }: ProjectsSettingsProps): JSX.Element {
  const [folders, setFolders] = useState<TrustRecord[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const result = await bridge.call('trust.list', {});
    setFolders(result.folders);
  }, [bridge]);

  useEffect(() => {
    let alive = true;
    bridge.call('trust.list', {}).then(
      (result) => {
        if (alive) setFolders(result.folders);
      },
      (err: unknown) => {
        console.warn('[parley] trust.list', 'failed');
        if (alive) setError(errorText(decodeIpcError(err).code, S.errors.actions.loadTrustedFolders));
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const revoke = async (folder: string): Promise<void> => {
    setRevoking(folder);
    setError(null);
    try {
      await bridge.call('trust.revoke', { folder });
      await load();
    } catch (err) {
      console.warn('[parley] trust.revoke', 'failed');
      setError(errorText(decodeIpcError(err).code, S.errors.actions.revokeTrust));
    } finally {
      setRevoking(null);
    }
  };

  const text = S.settings;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="m-0 text-xs text-muted-foreground">{text.projectsHint}</p>
      {error !== null ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
      {folders !== null && folders.length === 0 ? <p className="m-0 text-muted-foreground">{text.projectsEmpty}</p> : null}
      {folders !== null && folders.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {folders.map((record) => (
            <li key={record.folder} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span title={record.folder} className="truncate font-mono text-[13px]">
                  {shortenMiddle(record.folder)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {text.projectsGrantedAt(record.grantedAt)} · {text.projectsBy(record.by)}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revoking !== null}
                aria-label={`${text.projectsRevoke} ${record.folder}`}
                onClick={() => void revoke(record.folder)}
              >
                {text.projectsRevoke}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
