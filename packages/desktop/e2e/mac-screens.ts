import { execFileSync } from 'node:child_process';

/**
 * Дисплеи по данным macOS: номер дисплея (тот же id, что у Electron) и высота выреза (`safeAreaInsets.top`, 0 — выреза
 * нет). Не macOS — пустой список.
 */
export function macScreens(): Array<{ id: number; top: number }> {
  if (process.platform !== 'darwin') return [];
  const script = [
    'ObjC.import("AppKit");',
    'var screens = $.NSScreen.screens, out = [];',
    'for (var i = 0; i < screens.count; i++) {',
    '  var screen = screens.objectAtIndex(i);',
    '  out.push({ id: screen.deviceDescription.objectForKey("NSScreenNumber").unsignedIntValue, top: screen.safeAreaInsets.top });',
    '}',
    'JSON.stringify(out);',
  ].join('\n');
  return JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 10_000 })) as Array<{ id: number; top: number }>;
}
