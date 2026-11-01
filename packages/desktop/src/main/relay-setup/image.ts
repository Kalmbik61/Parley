/**
 * The relay image this build of Parley installs, pinned by digest (spec 6.7: «образ relay той версии, что у Parley
 * на Маке, по закреплённому digest»).
 *
 * PLACEHOLDER: the image is not published yet. The human publishes it to GHCR (amd64 and arm64) at release time and
 * pastes the digest below. Until then the wizard refuses to install on a real server (`isImagePublished` is false);
 * the Docker test stand builds the image from `packages/relay/Dockerfile` and passes its own reference.
 */
export const RELAY_IMAGE_REPOSITORY = 'ghcr.io/kalmbik61/parley-relay';
export const RELAY_IMAGE_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

const REFERENCE = /^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9._-]{1,64})?(?:@sha256:[0-9a-f]{64})?$/;

export function isValidImageRef(ref: string): boolean {
  return REFERENCE.test(ref);
}

export const pinnedImageRef = (): string => `${RELAY_IMAGE_REPOSITORY}@${RELAY_IMAGE_DIGEST}`;

export const isImagePublished = (): boolean => !/^sha256:0+$/.test(RELAY_IMAGE_DIGEST);
