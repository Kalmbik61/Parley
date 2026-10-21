/**
 * Подставной `AudioContext` для тестов окна: в jsdom WebAudio нет, и настоящий сигнал «нужно действие»
 * (`attention/chime.ts`) печатал бы в консоль `chime failed ReferenceError`. Тест ставит его сам:
 * `vi.stubGlobal('AudioContext', AudioContextStub)` в `beforeEach`, `vi.unstubAllGlobals()` в `afterEach`.
 * `vitest` здесь не импортируется: файл входит в `tsconfig.web.json`, а типы vitest подменили бы `setTimeout`.
 */

export class AudioContextStub {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume = async (): Promise<void> => undefined;
  createOscillator() {
    return { type: 'sine', frequency: { value: 0 }, connect: () => undefined, start: () => undefined, stop: () => undefined };
  }
  createGain() {
    return { gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined };
  }
}
