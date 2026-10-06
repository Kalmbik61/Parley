/**
 * Процессор AudioWorklet записи (спека 4.1): каждый кадр первого канала уходит в окно копией — буфер кадра
 * движок звука переиспользует. Выход не пишется: узел подключён к destination только чтобы граф его тянул.
 */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class PcmCapture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel !== undefined) this.port.postMessage(channel.slice(0));
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
