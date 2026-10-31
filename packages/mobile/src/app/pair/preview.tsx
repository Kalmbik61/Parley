// Developer build only: `parley:///pair/preview?step=sas` shows a pairing step without a Mac (screenshots, design review).
import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { pairing } from '../../pairing/instance';
import { describeFailure, type PairState } from '../../pairing/session';
import { PairError, type HostRecord } from '@parley/remote-client';

const URL_FIXTURE = `parley://pair?v=1&k=${'A'.repeat(43)}&s=${'A'.repeat(22)}&r=relay.example.com`;
const RECORD = { hostId: 'x', hostName: "Evgeniy's MacBook Pro" } as HostRecord;

export default function Preview() {
  const { step } = useLocalSearchParams<{ step?: string }>();
  const router = useRouter();
  useEffect(() => {
    if (!__DEV__) return void router.replace('/');
    const states: Record<string, PairState> = {
      confirm: { step: 'confirm-link', url: URL_FIXTURE },
      name: { step: 'name', url: URL_FIXTURE },
      connecting: { step: 'connecting', url: URL_FIXTURE },
      sas: { step: 'sas', url: URL_FIXTURE, code: '123456', expiresAt: Date.now() + 114_000 },
      paired: { step: 'paired', record: RECORD },
      notify: { step: 'notify', record: RECORD },
      denied: { step: 'failed', url: URL_FIXTURE, failure: describeFailure(new PairError('denied'), null) },
      used: { step: 'failed', url: URL_FIXTURE, failure: describeFailure(new PairError('offer_closed'), null) },
    };
    const next = states[step ?? 'sas'];
    if (next) pairing.previewStep(next);
    router.replace('/pair/flow');
  }, [step, router]);
  return null;
}
