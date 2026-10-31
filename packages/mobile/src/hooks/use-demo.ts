import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { demoRoute, installDemo } from '../dev/demo';
import { DEMO, DEMO_ROUTE } from '../dev/flags';
import { useClient } from './use-remote';

const route = DEMO ? demoRoute(DEMO_ROUTE) : null;

export function useDemoData(): void {
  const client = useClient();
  const router = useRouter();
  useEffect(() => {
    if (!DEMO || client === null) return;
    installDemo(client);
    if (route !== null) setTimeout(() => router.push(route as never), 1500);
  }, [client]);
}
