import { describe, expect, it } from 'vitest';
import {
  isImagePublished,
  isValidImageRef,
  pinnedImageRef,
  RELAY_IMAGE_PLACEHOLDER_DIGEST,
  RELAY_IMAGE_REPOSITORY,
  resolveImageDigest,
} from './image';

const REAL = `sha256:${'ab12'.repeat(16)}`;

describe('relay image pin', () => {
  it('a well-formed build-time digest is used as is', () => {
    expect(resolveImageDigest(REAL)).toBe(REAL);
  });

  it.each([undefined, '', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `${REAL}\n`, `sha1:${'a'.repeat(40)}`, 'latest'])(
    'missing or malformed digest %j falls back to the placeholder',
    (raw) => {
      expect(resolveImageDigest(raw)).toBe(RELAY_IMAGE_PLACEHOLDER_DIGEST);
    },
  );

  it('without a build-time define the image counts as not published', () => {
    expect(isImagePublished()).toBe(false);
    expect(pinnedImageRef()).toBe(`${RELAY_IMAGE_REPOSITORY}@${RELAY_IMAGE_PLACEHOLDER_DIGEST}`);
  });

  it('the pinned reference is a valid image reference', () => {
    expect(isValidImageRef(pinnedImageRef())).toBe(true);
    expect(isValidImageRef(`${RELAY_IMAGE_REPOSITORY}@${REAL}`)).toBe(true);
  });
});
