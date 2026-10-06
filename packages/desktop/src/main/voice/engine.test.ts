import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEngine, VAD_MODEL_FILE } from './engine.js';

const files = (list: string[]) => (candidate: string): boolean => list.includes(candidate);

describe('resolveEngine (спека 4.2)', () => {
  it('упакованное окно: Resources/whisper/bin/whisper-cli и модель VAD рядом', () => {
    const resources = '/Applications/Parley.app/Contents/Resources';
    const bin = path.join(resources, 'whisper', 'bin', 'whisper-cli');
    const vad = path.join(resources, 'whisper', VAD_MODEL_FILE);
    expect(resolveEngine({ isPackaged: true, resourcesPath: resources, devDir: '/x', pathEnv: '/opt/homebrew/bin', isFile: files([bin, vad]) })).toEqual({ bin, vadModel: vad });
  });

  it('упакованное окно без движка — null, PATH не смотрится', () => {
    expect(resolveEngine({ isPackaged: true, resourcesPath: '/r', devDir: '/x', pathEnv: '/opt/homebrew/bin', isFile: files(['/opt/homebrew/bin/whisper-cli']) })).toBeNull();
  });

  it('разработка: сначала build/whisper, потом PATH; VAD — из build/whisper', () => {
    const vad = path.join('/dev/whisper', VAD_MODEL_FILE);
    const local = path.join('/dev/whisper', 'bin', 'whisper-cli');
    expect(resolveEngine({ isPackaged: false, resourcesPath: '/r', devDir: '/dev/whisper', pathEnv: '/opt/homebrew/bin', isFile: files([vad, local, '/opt/homebrew/bin/whisper-cli']) })).toEqual({ bin: local, vadModel: vad });
    expect(resolveEngine({ isPackaged: false, resourcesPath: '/r', devDir: '/dev/whisper', pathEnv: '/usr/bin:/opt/homebrew/bin', isFile: files([vad, '/opt/homebrew/bin/whisper-cli']) })).toEqual({ bin: '/opt/homebrew/bin/whisper-cli', vadModel: vad });
  });

  it('разработка без модели VAD — null', () => {
    expect(resolveEngine({ isPackaged: false, resourcesPath: '/r', devDir: '/dev/whisper', pathEnv: '/opt/homebrew/bin', isFile: files(['/opt/homebrew/bin/whisper-cli']) })).toBeNull();
  });
});
