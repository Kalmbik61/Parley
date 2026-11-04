/**
 * Браузерная обвязка Live-контроллера: микрофон с эхоподавлением, `RTCPeerConnection`, воспроизведение удалённого
 * трека и измерители уровня (RMS через `AnalyserNode`, как в харнессе T0). Логики здесь нет: она в `controller.ts`,
 * `levels.ts` и `events.ts`. Аудио и транскрипты не сохраняются и не логируются.
 */
import type { IslandBridge } from '../../../shared/island.js';
import type { LevelMeter, LiveControllerDeps, LiveMicStream, LivePeer, LiveSink } from './controller.js';
import { rms } from './levels.js';

const FFT_SIZE = 1024;

export function createBrowserLiveDeps(bridge: Pick<IslandBridge, 'call' | 'on'> & { island: Pick<IslandBridge['island'], 'voice'> }): LiveControllerDeps {
  let context: AudioContext | null = null;
  const audioContext = (): AudioContext => {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
  };

  return {
    call: bridge.call,
    onHostEvent: bridge.on,
    ensureMic: async () => {
      const status = await bridge.island.voice.micStatus();
      return status === 'granted' || (status === 'not-determined' && (await bridge.island.voice.requestMic()));
    },
    // Эхоподавление обязательно: без него звук модели из динамиков попадает в микрофон и включает `humanSpeaking`.
    openMic: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) as Promise<LiveMicStream>,
    createPeer: () => new RTCPeerConnection() as unknown as LivePeer,
    meter: (stream): LevelMeter => {
      const ctx = audioContext();
      const source = ctx.createMediaStreamSource(stream as MediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      // Анализатор не подключён к выходу: уровень читаем, второй раз звук не играем.
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      return {
        read: () => {
          analyser.getFloatTimeDomainData(data);
          return rms(data);
        },
        stop: () => {
          try {
            source.disconnect();
          } catch {
            // уже отключён
          }
        },
      };
    },
    sink: (): LiveSink => {
      const audio = new Audio();
      audio.autoplay = true;
      return {
        attach: (stream) => {
          audio.srcObject = stream as MediaStream;
          void audio.play().catch(() => {});
        },
        stop: () => {
          audio.pause();
          audio.srcObject = null;
        },
      };
    },
    now: () => performance.now(),
    setTick: (callback, ms) => {
      const id = setInterval(callback, ms);
      return () => clearInterval(id);
    },
  };
}
