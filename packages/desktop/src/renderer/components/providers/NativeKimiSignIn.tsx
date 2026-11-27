import { useState } from 'react';
import type { KimiLoginRegion } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { useProvidersStore } from '../../store/providers.js';
import { Button } from '../../ui/button.js';
import { SignInTerminal } from './SignInTerminal.js';

/** Native Kimi uses the same host-owned login PTY as subscription accounts. */
export function NativeKimiSignIn({
  running,
  onReload,
}: {
  running: boolean;
  onReload: () => Promise<void>;
}): JSX.Element {
  const sharedRunning = useProvidersStore(
    (state) => state.providers.find((provider) => provider.id === 'kimi')?.kimiAuth?.signingIn,
  );
  const result = useProvidersStore((state) => state.signInResult.kimi);
  const [runs, setRuns] = useState(0);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = sharedRunning ?? running;
  const signIn = async (region: KimiLoginRegion): Promise<void> => {
    setPending(true);
    setFailed(false);
    setRuns((value) => value + 1);
    useProvidersStore.getState().beginSignIn('kimi');
    try {
      await window.parley.call('providers.signIn', { provider: 'kimi', region });
    } catch {
      setFailed(true);
      useProvidersStore.setState((state) => ({
        providers: state.providers.map((provider) =>
          provider.id === 'kimi' ? { ...provider, kimiAuth: { signingIn: false } } : provider,
        ),
      }));
    } finally {
      setPending(false);
      void onReload().catch(() => {});
    }
  };
  const cancel = async (): Promise<void> => {
    setFailed(false);
    try {
      await window.parley.call('providers.cancelSignIn', { provider: 'kimi' });
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="space-y-2">
      {active ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void cancel()}
        >
          {S.accounts.cancel}
        </Button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void signIn('mainland-cn')}
          >
            <span className="flex flex-col items-start leading-tight">
              <span>kimi.com</span>
              <span className="text-[10px] font-normal text-muted-foreground">{S.providerCard.kimi.regionCn}</span>
            </span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void signIn('global')}
          >
            <span className="flex flex-col items-start leading-tight">
              <span>kimi.ai</span>
              <span className="text-[10px] font-normal text-muted-foreground">{S.providerCard.kimi.regionGlobal}</span>
            </span>
          </Button>
        </div>
      )}
      {active || runs > 0 || result !== undefined ? (
        <SignInTerminal key={runs} provider="kimi" running={active && !pending} />
      ) : null}
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {S.accounts.signInStartFailed}
        </p>
      ) : null}
      {!active && result !== undefined ? (
        <p role="status" className="text-xs">
          {result.signedIn ? S.accounts.signInDone : S.accounts.signInFailed}
        </p>
      ) : null}
    </div>
  );
}
