/**
 * Settings → About: версия, сборка, окружение, «Check now», «Release notes», «Copy info», переключатель
 * автопроверки и строка самообновления (план about-section, A3). Сведения берутся у main один раз при открытии
 * раздела (`app.aboutInfo`), версия хоста — из статуса связи в сторе окна.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { AboutInfo, ParleyBridge, UpdateCheckResult } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Switch } from '../../ui/switch.js';
import { UpdateSettingsRow } from '../../update/UpdateSettingsRow.js';
import { aboutText } from './about-text.js';

const A = S.settings.about;

function resultText(result: UpdateCheckResult): string {
  switch (result.kind) {
    case 'current':
      return A.current(result.latest);
    case 'available':
      return A.available(result.latest);
    case 'unavailable':
      return A.unavailable;
    case 'failed':
      return result.reason === 'network' ? A.network : result.reason === 'rate_limited' ? A.rateLimited : A.badResponse;
  }
}

export function AboutSettings({ bridge }: { bridge: ParleyBridge }): JSX.Element {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const hostStatus = useHostStore((state) => state.status);
  const ui = useUiStore((state) => state.ui);
  const uiLoaded = useUiStore((state) => state.uiLoaded);
  const patchUi = useUiStore((state) => state.patchUi);

  useEffect(() => {
    let alive = true;
    bridge.app.aboutInfo().then(
      (value) => {
        if (alive) setInfo(value);
      },
      (error: unknown) => console.warn('[parley] about info', error),
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  if (info === null) return <div />;

  const hostVersion = hostStatus.state === 'connected' || hostStatus.state === 'mismatch' ? hostStatus.hostVersion : null;
  const build = A.build(info.commit, info.commitDate, info.arch, info.dirty);
  const rows: Array<[string, string]> = [
    [A.host, hostVersion ?? A.notConnected],
    [A.electron, info.electron],
    [A.chromium, info.chrome],
    [A.node, info.node],
    [A.macos, info.os.replace(/^macOS\s+/, '')],
    ...(info.appPath === null ? [] : [[A.app, info.appPath] as [string, string]]),
    [A.data, info.dataDir],
  ];

  const checkNow = (): void => {
    setChecking(true);
    bridge.app.checkForUpdates().then(
      (value) => setResult(value),
      (error: unknown) => console.warn('[parley] check for updates', error),
    ).finally(() => setChecking(false));
  };

  const copy = (): void => {
    navigator.clipboard.writeText(aboutText(info, hostVersion)).then(
      () => toast(A.copied),
      (error: unknown) => console.warn('[parley] copy about info', error),
    );
  };

  // До первой ручной проверки показывается последняя, что была (плановая или прошлая ручная).
  const shown = result;
  const last = shown === null && info.lastCheck !== null && info.lastCheck.kind !== 'unavailable' ? info.lastCheck : null;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <h3 className="text-base font-medium">{A.title(info.version)}</h3>
        {build !== '' ? <p className="text-xs text-muted-foreground">{build}</p> : null}
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="select-text break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={checking || !info.updateChecks} onClick={checkNow}>
          {A.checkNow}
        </Button>
        {info.version !== null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              bridge.app
                .openExternal(`https://github.com/Kalmbik61/Parley/releases/tag/v${info.version}`)
                .catch((error: unknown) => console.warn('[parley] release notes', error));
            }}
          >
            {A.releaseNotes}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {A.copyInfo}
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {checking
          ? A.checking
          : shown !== null
            ? resultText(shown)
            : !info.updateChecks
              ? A.unavailable
              : last !== null
                ? A.lastChecked(new Date(last.checkedAt).toLocaleString())
                : ''}
      </p>
      {uiLoaded ? (
        <>
          <label className="flex items-center justify-between gap-2">
            <span>{S.settings.checkForUpdates}</span>
            <Switch checked={ui.checkForUpdates} onCheckedChange={(checked) => patchUi({ checkForUpdates: checked })} />
          </label>
          <p className="text-xs text-muted-foreground">{S.settings.checkForUpdatesHint}</p>
        </>
      ) : null}
      <UpdateSettingsRow bridge={bridge} />
    </div>
  );
}
