/** Подключение диктовки к окну (спека 4.1): мост, `ui.json`, запись, тосты sonner, буфер обмена. */
import { toast } from 'sonner';
import type { ParleyBridge } from '../../shared/bridge.js';
import { useUiStore } from '../store/ui.js';
import { browserRecorderDeps } from './browser-recorder.js';
import { useDictationStore } from './dictation-store.js';
import { startRecording } from './recorder.js';

export function wireDictation(bridge: ParleyBridge): () => void {
  return useDictationStore.getState().configure({
    voice: bridge.voice,
    settings: () => useUiStore.getState().ui.voice,
    record: (onLevel) => startRecording(onLevel, browserRecorderDeps()),
    toast: (text, action) => {
      if (action === undefined) toast(text);
      else toast(text, { action: { label: action.label, onClick: () => action.onClick() } });
    },
    openVoiceSettings: () => useUiStore.getState().openSettingsDialog(),
    copy: (text) => navigator.clipboard.writeText(text),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    now: () => Date.now(),
  });
}
