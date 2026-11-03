/**
 * The relay image this build of Parley installs, pinned by digest (spec 6.7: «образ relay той версии, что у Parley
 * на Маке, по закреплённому digest»).
 *
 * The release workflow publishes the image to GHCR (amd64 and arm64) and passes its manifest-list digest to the build
 * as PARLEY_RELAY_IMAGE_DIGEST; electron-vite bakes it into the main bundle as `__PARLEY_RELAY_IMAGE_DIGEST__`.
 * Without it (dev, tests, a dry run) the all-zero placeholder stays and the wizard refuses to install on a real
 * server (`isImagePublished` is false); the Docker test stand builds the image from `packages/relay/Dockerfile` and
 * passes its own reference.
 */
export const RELAY_IMAGE_REPOSITORY = 'ghcr.io/kalmbik61/parley-relay';
export const RELAY_IMAGE_PLACEHOLDER_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

declare const __PARLEY_RELAY_IMAGE_DIGEST__: string | undefined;

/** A build-time digest if it is a well-formed `sha256:<64 hex>`, otherwise the placeholder. */
export function resolveImageDigest(raw: string | undefined): string {
  return raw !== undefined && /^sha256:[0-9a-f]{64}$/.test(raw) ? raw : RELAY_IMAGE_PLACEHOLDER_DIGEST;
}

export const RELAY_IMAGE_DIGEST = resolveImageDigest(
  typeof __PARLEY_RELAY_IMAGE_DIGEST__ === 'string' ? __PARLEY_RELAY_IMAGE_DIGEST__ : undefined,
);

const REFERENCE = /^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9._-]{1,64})?(?:@sha256:[0-9a-f]{64})?$/;

export function isValidImageRef(ref: string): boolean {
  return REFERENCE.test(ref);
}

export const pinnedImageRef = (): string => `${RELAY_IMAGE_REPOSITORY}@${RELAY_IMAGE_DIGEST}`;

export const isImagePublished = (): boolean => !/^sha256:0+$/.test(RELAY_IMAGE_DIGEST);
