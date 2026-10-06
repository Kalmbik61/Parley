/**
 * Настоящие зависимости записи (спека 4.1): микрофон Chromium, `AudioContext` 16 кГц и worklet `pcm-capture`. Модуль
 * worklet грузится лениво — только когда запись действительно начинается; тесты сюда не заходят.
 */
import { RECORDING_SAMPLE_RATE, type CaptureContext, type CaptureNode, type RecorderDeps } from './recorder.js';

export function browserRecorderDeps(): RecorderDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createContext: () => new AudioContext({ sampleRate: RECORDING_SAMPLE_RATE }) as unknown as CaptureContext,
    createNode: (context) => new AudioWorkletNode(context as unknown as AudioContext, 'pcm-capture') as unknown as CaptureNode,
    workletUrl: () => import('./pcm-capture.worklet.ts?worker&url').then((module) => module.default),
  };
}
