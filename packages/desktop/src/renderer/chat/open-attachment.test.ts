import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Located } from '../../shared/files-types.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { openLinkInEditor } from '../terminal/LinkMenu.js';
import { openAttachmentImage } from './open-attachment.js';

vi.mock('../terminal/LinkMenu.js', () => ({ openLinkInEditor: vi.fn() }));

afterEach(() => vi.mocked(openLinkInEditor).mockClear());

const target = { path: '/proj/docs/shot.png', label: 'shot.png', thumbnail: 'data:image/png;base64,AAAA' };
const located: Located = { root: { workKey: 'w', spec: { kind: 'project' } }, relPath: 'docs/shot.png', stat: { kind: 'file', size: 1, mtimeMs: 0 } };

describe('openAttachmentImage', () => {
  it('картинка в корне работы — вкладка файла (просмотр), диалог не открывается', async () => {
    const bridge = createFakeBridge();
    bridge.setLocated('w', target.path, located);
    const openPreview = vi.fn();
    await openAttachmentImage({ bridge, workKey: 'w', openPreview }, target, null);
    expect(openLinkInEditor).toHaveBeenCalledWith({ kind: 'path', absPath: target.path, located });
    expect(openPreview).not.toHaveBeenCalled();
  });

  it('вне корней (drops/, Finder), чужой корень или сбой locate — диалог просмотра ленты', async () => {
    const opener = document.createElement('button');
    for (const answer of [null, { ...located, root: { ...located.root, workKey: 'other' } }, 'fail'] as const) {
      const bridge = createFakeBridge();
      if (answer === 'fail') bridge.files.locate = () => Promise.reject(new Error('down'));
      else bridge.setLocated('w', target.path, answer);
      const openPreview = vi.fn();
      await openAttachmentImage({ bridge, workKey: 'w', openPreview }, target, opener);
      expect(openPreview).toHaveBeenCalledWith(target, opener);
    }
    expect(openLinkInEditor).not.toHaveBeenCalled();
  });
});
