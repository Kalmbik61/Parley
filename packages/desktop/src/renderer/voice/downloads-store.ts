/**
 * Скачивание моделей Whisper (спека 3.1, 6.2): состояние живёт в окне, а не во вкладке Settings → Voice — закрытие
 * настроек или смена вкладки посреди скачивания его не теряет. Мост подключает `wire.ts` (`bind`); store сам зовёт
 * `bridge.voice`, показывает тосты ошибок и по завершении обновляет список и выбирает модель, если её не было.
 */
import { toast } from 'sonner';
import { create } from 'zustand';
import { S } from '../../shared/strings.js';
import type { DownloadResult, VoiceApi, VoiceModelId } from '../../shared/voice-types.js';
import { useUiStore } from '../store/ui.js';

/** Копия записи без ключа `id` (линт не любит неиспользуемую переменную в деструктуризации). */
function omitKey<T>(record: Partial<Record<VoiceModelId, T>>, id: VoiceModelId): Partial<Record<VoiceModelId, T>> {
  const next = { ...record };
  delete next[id];
  return next;
}

export interface DownloadsState {
  downloaded: readonly VoiceModelId[];
  /** Скачано байт по id модели; ключа нет — прогресса нет. */
  progress: Partial<Record<VoiceModelId, number>>;
  busy: Partial<Record<VoiceModelId, true>>;
  /** Подключает мост и подписку на прогресс; отдаёт отписку. */
  bind(voice: VoiceApi): () => void;
  refresh(): Promise<readonly VoiceModelId[]>;
  download(id: VoiceModelId): Promise<void>;
  cancel(id: VoiceModelId): Promise<void>;
  remove(id: VoiceModelId): Promise<void>;
}

const EMPTY = { downloaded: [] as readonly VoiceModelId[], progress: {}, busy: {} };

function patchVoice(patch: Partial<ReturnType<typeof useUiStore.getState>['ui']['voice']>): void {
  const { ui, patchUi } = useUiStore.getState();
  patchUi({ voice: { ...ui.voice, ...patch } });
}

export const useDownloadsStore = create<DownloadsState>((set, get) => {
  let api: VoiceApi | null = null;

  return {
    ...EMPTY,

    bind(voice) {
      api = voice;
      set(EMPTY);
      const unsubscribe = voice.onProgress((next) => set((state) => ({ progress: { ...state.progress, [next.id]: next.receivedBytes } })));
      void get().refresh();
      return () => {
        unsubscribe();
        if (api === voice) api = null;
      };
    },

    async refresh() {
      if (api === null) return get().downloaded;
      const list = await api.listModels().catch(() => [] as VoiceModelId[]);
      set({ downloaded: list });
      return list;
    },

    async download(id) {
      const voice = api;
      if (voice === null) return;
      set((state) => ({ busy: { ...state.busy, [id]: true } }));
      const result: DownloadResult = await voice.downloadModel(id).catch(() => ({ error: 'network' }) as const);
      set((state) => ({ busy: omitKey(state.busy, id), progress: omitKey(state.progress, id) }));
      if ('ok' in result) {
        await get().refresh();
        if (useUiStore.getState().ui.voice.model === null) patchVoice({ model: id });
        return;
      }
      if (result.error === 'disk_full') toast(S.voice.diskFull(Math.ceil(result.needBytes / 1_000_000)));
      else if (result.error === 'corrupted') toast(S.voice.downloadCorrupted);
      else if (result.error === 'network') toast(S.voice.downloadFailed);
    },

    async cancel(id) {
      await api?.cancelDownload(id);
    },

    async remove(id) {
      await api?.removeModel(id).catch(() => undefined);
      const list = await get().refresh();
      const current = useUiStore.getState().ui.voice;
      if (current.model !== id) return;
      const next = list[0] ?? null;
      patchVoice({ model: next, enabled: next !== null && current.enabled });
    },
  };
});
