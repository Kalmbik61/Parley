// Заплатка библиотеки (спека 2.2) должна лежать в установленных файлах: обновили версию или сняли заплатку — тест падает.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = dirname(createRequire(import.meta.url).resolve('expo-speech-recognition/package.json'));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('expo-speech-recognition patch', () => {
  const recognizer = read('ios/ExpoSpeechRecognizer.swift');
  const module = read('ios/ExpoSpeechRecognitionModule.swift');

  it('the guard sits inside startRecognizer, after the isAvailable guard and before prepareRequest', () => {
    const start = recognizer.indexOf('private func startRecognizer(');
    const available = recognizer.indexOf('recognizer.isAvailable', start);
    const guard = recognizer.indexOf('options.requiresOnDeviceRecognition && !recognizer.supportsOnDeviceRecognition', start);
    const prepare = recognizer.indexOf('Self.prepareRequest(', start);
    expect(start).toBeGreaterThan(0);
    expect(available).toBeGreaterThan(start);
    expect(guard).toBeGreaterThan(available);
    expect(prepare).toBeGreaterThan(guard);
    const body = recognizer.slice(guard, prepare);
    expect(body).toContain('RecognizerError.nilRecognizer');
    expect(body).toContain('reset(andEmitEnd: true)');
    expect(body).toContain('return');
  });

  it('prepareRequest sets requiresOnDeviceRecognition without a condition', () => {
    const prepare = recognizer.slice(recognizer.indexOf('private static func prepareRequest('));
    expect(prepare).toContain('request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition');
    expect(prepare).not.toMatch(/if recognizer\.supportsOnDeviceRecognition\s*\{/);
  });

  it('supportsOnDeviceRecognition takes a language', () => {
    expect(module).toMatch(/Function\("supportsOnDeviceRecognition"\)\s*\{\s*\(lang: String\?\)/);
    expect(module).toContain('SFSpeechRecognizer(locale: Locale(identifier: $0))');
    expect(read('build/ExpoSpeechRecognitionModule.types.d.ts')).toContain('supportsOnDeviceRecognition(lang?: string): boolean');
  });

  // Hunk 4 belongs to option (a) of spec 2.3 (keyboard language); with option (b) this test goes together with it.
  it('currentInputLanguage runs on the main queue', () => {
    expect(module).toMatch(/AsyncFunction\("currentInputLanguage"\)[\s\S]*\.runOnQueue\(\.main\)/);
    expect(read('build/ExpoSpeechRecognitionModule.types.d.ts')).toContain('currentInputLanguage(): Promise<string | null>');
  });
});
