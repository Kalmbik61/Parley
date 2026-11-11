import { describe, expect, it } from 'vitest';
import {
  PROCESS_INFO_LINES,
  PROFILE_TEMPLATE,
  PROFILE_TEMPLATE_SHA256,
  ProfileError,
  type ProfilePaths,
  ancestorsOf,
  profilePath,
  renderHelperProfile,
  renderProbeProfile,
  sha256,
} from './helper-profile.js';

const paths: ProfilePaths = {
  node: '/opt/node/bin/node',
  helper: '/app/core/dist/mcp/code-mode/helper-entry.js',
  probes: '/app/core/dist/mcp/code-mode/guest.js',
  qjsCore: '/app/node_modules/.pnpm/quickjs-emscripten-core@0.32.0/node_modules/quickjs-emscripten-core',
  qjsSync: '/app/node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@0.32.0/node_modules/@jitl/quickjs-wasmfile-release-sync',
  qjsFfi: '/app/node_modules/.pnpm/@jitl+quickjs-ffi-types@0.32.0/node_modules/@jitl/quickjs-ffi-types',
  metadata: ['/app', '/app/node_modules', '/opt'],
};

describe('pinned r4 template', () => {
  it('is the accepted T2b r4 template, byte for byte (sha256 79a03062…, plan T2b record)', () => {
    expect(sha256(PROFILE_TEMPLATE)).toBe(PROFILE_TEMPLATE_SHA256);
    expect(PROFILE_TEMPLATE_SHA256).toBe('79a0306288b24f3551b43bb525722d4eb83a996b00009ec701cc61b3e093cb21');
  });

  it('denies by default, grants no sysctl and carries each process-info line exactly once', () => {
    expect(PROFILE_TEMPLATE.split('\n')[2]).toBe('(deny default)');
    expect(PROFILE_TEMPLATE).not.toMatch(/^\(allow sysctl/m);
    expect(PROFILE_TEMPLATE).not.toMatch(/^\(allow network/m);
    for (const line of PROCESS_INFO_LINES) expect(PROFILE_TEMPLATE.split('\n').filter((l) => l === line)).toHaveLength(1);
  });
});

describe('rendering', () => {
  it('substitutes every placeholder with the given real paths and sorted, de-duplicated metadata literals', () => {
    const text = renderHelperProfile({ ...paths, metadata: ['/opt', '/app', '/opt'] });
    expect(text).not.toMatch(/@[A-Z_]+@/);
    expect(text).toContain('(allow process-exec (literal "/opt/node/bin/node"))');
    expect(text).toContain(`(literal "${paths.helper}") (literal "${paths.probes}") (subpath "${paths.qjsCore}") (subpath "${paths.qjsSync}") (subpath "${paths.qjsFfi}")`);
    expect(text).toContain('(allow file-read-metadata (literal "/app") (literal "/opt"))');
    // Everything except the substituted lines is the template unchanged.
    const strip = (t: string): string[] => t.split('\n').filter((l) => !l.includes('literal "') && !l.includes('subpath "') && !l.includes('file-read-metadata'));
    expect(strip(text)).toEqual(strip(PROFILE_TEMPLATE));
  });

  it('is single-pass: a value that contains @ is kept verbatim and never re-expanded', () => {
    const text = renderHelperProfile({ ...paths, helper: '/a/@jitl+x@0.32.0/h.js' });
    expect(text).toContain('(literal "/a/@jitl+x@0.32.0/h.js")');
  });

  const bad: [string, unknown][] = [
    ['relative', 'a/b'],
    ['not normalized', '/a/../b'],
    ['trailing slash', '/a/b/'],
    ['quote', '/a/"b'],
    ['backslash', '/a\\b'],
    ['newline', '/a\nb'],
    ['control', '/a\u0001b'],
    ['placeholder-like', '/a/@NODE@/b'],
    ['not a string', 42],
    ['too long', `/${'a'.repeat(1100)}`],
  ];
  it.each(bad)('refuses a %s path in any slot', (_label, value) => {
    expect(() => profilePath(value)).toThrow(ProfileError);
    expect(() => renderHelperProfile({ ...paths, qjsFfi: value as string })).toThrow(ProfileError);
    expect(() => renderHelperProfile({ ...paths, metadata: [value as string] })).toThrow(ProfileError);
  });

  it('refuses an empty metadata list', () => {
    expect(() => renderHelperProfile({ ...paths, metadata: [] })).toThrow(ProfileError);
  });

  it('the probe profile is the helper profile plus exactly exec and read of the probe literal', () => {
    const helper = renderHelperProfile(paths);
    const probe = renderProbeProfile(paths, '/app/core/native/darwin-arm64/procinfo-probe');
    expect(probe.startsWith(helper)).toBe(true);
    expect(probe.slice(helper.length)).toBe('(allow process-exec (literal "/app/core/native/darwin-arm64/procinfo-probe"))\n(allow file-read* (literal "/app/core/native/darwin-arm64/procinfo-probe"))\n');
    expect(() => renderProbeProfile(paths, 'relative/probe')).toThrow(ProfileError);
  });

  it('the fixture positive control differs from the probe profile only by the two process-info lines', () => {
    const probe = renderProbeProfile(paths, '/p/procinfo-probe');
    const control = probe.split('\n').filter((l) => !PROCESS_INFO_LINES.includes(l)).join('\n');
    expect(probe.split('\n').length - control.split('\n').length).toBe(2);
  });

  it('ancestorsOf lists every directory above a path, excluding /', () => {
    expect(ancestorsOf('/a/b/c.js')).toEqual(['/a/b', '/a']);
    expect(ancestorsOf('/c.js')).toEqual([]);
  });
});
