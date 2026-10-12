// packages/desktop/src/main/browser/react-info.ts
/**
 * Адаптация Orca `src/main/browser/grab-guest-react-script.ts` (stablyai/orca b1cd858, MIT). Copyright (c) 2026
 * Lovecast Inc.; полный текст лицензии — в NOTICE в корне репозитория.
 *
 * Компонент React и источник выбранного элемента (спека браузера 3.8). `REACT_INFO_FN` — единственная функция, которую
 * main исполняет в мире страницы: через `Runtime.callFunctionOn`, и закрытый список CDP пускает этот метод только с ней
 * (`inspector.ts#cdpCallAllowed`). Свойство `__reactFiber$…` лежит на обёртке узла в мире страницы — из изолированного
 * мира скриптов выбора его не видно, поэтому это одна функция по CDP, а не часть `guest-pick.js`.
 *
 * Взято у Orca: волокно по ключам `__reactFiber$` и `__reactInternalInstance$` (React 16–19), имя компонента у
 * `forwardRef` (`type.render`) и `memo` (`type.type`), очистка пути исходника (webpack, turbopack, `http://хост/`,
 * `file://`, query), предел подъёма — 35 звеньев. Изменено:
 * - пропуск каркаса — только точные имена (`Fragment`, `StrictMode`, `Suspense`, `Profiler`, `*.Provider`,
 *   `*.Consumer`): правила Orca по началу и концу имени (`Client…`, `Dev…`, `…Wrapper`, `…Context`) отбросили бы
 *   имена приложения; объекты-контексты имени не дают вовсе;
 * - до трёх компонентов изнутри наружу (`SaveButton < SettingsForm < SettingsPage`, спека 3.6), у каждого свой
 *   источник — место в его файле, где он нарисовал узел ниже по цепочке (`_debugSource`), а не одно поле на элемент;
 * - React 19 (`_debugStack`, у Orca его нет) — правило `parseDebugStack` этапа 0 (отчёт, 0.6): первые 6 строк стека,
 *   кадры рантайма JSX и пакетов React пропущены, первый оставшийся — место создания; пометка approx.: без source maps
 *   это позиция в собранном файле. Пакеты `react`, `react-dom` и `scheduler` узнаются по пути только под `node_modules`:
 *   папка `src/features/scheduler/`, `packages/react/` или хост `react-app.test` самого приложения — не рантайм, иначе
 *   у компонента пропал бы источник.
 * Из глобалов страницы функция берёт только встроенные, ошибки ловит. Всё, что она вернула, — данные страницы: форму и
 * длины проверяет `parseReactInfo`.
 */

import type { ReactComponentInfo } from '../../shared/browser-types.js';
import { cutCodePoints, isRecord } from './guest-data.js';

/**
 * Пределы React (спека браузера 8): до трёх компонентов, имя до 100, источник до 300. `depth` — подъём по `return` не
 * дальше 35 звеньев (как у Orca), `stackLines` — первые 6 строк `_debugStack` (правило этапа 0).
 */
export const REACT_LIMITS = { components: 3, name: 100, source: 300, depth: 35, stackLines: 6 } as const;

export const REACT_INFO_FN = `function () {
  try {
    var LIMIT = ${REACT_LIMITS.components};
    var DEPTH = ${REACT_LIMITS.depth};
    var FRAMEWORK = /^(?:Fragment|StrictMode|Suspense|Profiler)$|\\.(?:Provider|Consumer)$/;
    var FRAME = /^\\s*at (?:(.*?) \\()?(.*?):(\\d+):(\\d+)\\)?\\s*$/;
    var SKIP_FN = /^(?:exports\\.)?(?:jsxDEV|jsxs?|createElement)$|react_stack_bottom_frame|react-stack-top-frame/;
    var SKIP_URL = /node_modules[\\/\\\\](?:.*[\\/\\\\])?(?:react|react-dom|scheduler)(?:[\\/\\\\@.\\-_]|$)|react[-_]jsx[-_]?dev[-_]?runtime|jsx-dev-runtime|\\/node_modules\\/(?:\\.vite\\/deps\\/)?react/;
    var nameOf = function (type) {
      if (typeof type === 'function') return type.displayName || type.name || '';
      if (!type || typeof type !== 'object') return '';
      if (typeof type.render === 'function') return type.displayName || type.render.displayName || type.render.name || '';
      if (type.type) return type.displayName || nameOf(type.type);
      return '';
    };
    var cleanPath = function (path) {
      return String(path)
        .replace(/[?#].*$/, '')
        .replace(/^turbopack:\\/\\/\\/\\[project\\]\\//, '')
        .replace(/^webpack-internal:\\/\\/\\/\\.\\//, '')
        .replace(/^webpack-internal:\\/\\/\\//, '')
        .replace(/^webpack:\\/\\/\\/\\.\\//, '')
        .replace(/^webpack:\\/\\/\\//, '')
        .replace(/^turbopack:\\/\\/\\//, '')
        .replace(/^https?:\\/\\/[^/]+\\//, '')
        .replace(/^file:\\/\\/\\//, '/')
        .replace(/^\\([^)]+\\)\\/\\.\\//, '')
        .replace(/^\\.\\//, '');
    };
    var sourceOf = function (fiber) {
      var debugSource = fiber && fiber._debugSource;
      if (debugSource && typeof debugSource.fileName === 'string') {
        return { source: cleanPath(debugSource.fileName) + (typeof debugSource.lineNumber === 'number' ? ':' + debugSource.lineNumber : ''), approx: false };
      }
      var debugStack = fiber && fiber._debugStack;
      var lines = debugStack && typeof debugStack.stack === 'string' ? debugStack.stack.split('\\n').slice(0, ${REACT_LIMITS.stackLines}) : [];
      for (var i = 0; i < lines.length; i += 1) {
        var frame = FRAME.exec(lines[i]);
        if (!frame || SKIP_FN.test(frame[1] || '') || SKIP_URL.test(frame[2])) continue;
        return { source: cleanPath(frame[2]) + ':' + frame[3], approx: true };
      }
      return null;
    };
    var keys = Object.keys(this);
    var below = null;
    for (var k = 0; k < keys.length; k += 1) {
      if (keys[k].indexOf('__reactFiber$') === 0 || keys[k].indexOf('__reactInternalInstance$') === 0) {
        below = this[keys[k]];
        break;
      }
    }
    if (!below) return null;
    var out = [];
    var fiber = below.return;
    for (var depth = 0; fiber && out.length < LIMIT && depth < DEPTH; depth += 1) {
      var name = nameOf(fiber.type);
      if (typeof name === 'string' && name !== '' && !FRAMEWORK.test(name)) {
        var found = sourceOf(below);
        out.push({ name: name, source: found ? found.source : null, approx: found ? found.approx : false });
      }
      below = fiber;
      fiber = fiber.return;
    }
    return out;
  } catch (error) {
    return null;
  }
}`;

export function parseReactInfo(value: unknown): ReactComponentInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ReactComponentInfo[] = [];
  for (const item of value.slice(0, REACT_LIMITS.components)) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') continue;
    const source = typeof item.source === 'string' && item.source !== '' ? cutCodePoints(item.source, REACT_LIMITS.source).text : null;
    out.push({ name: cutCodePoints(item.name, REACT_LIMITS.name).text, source, approx: item.approx === true });
  }
  return out.length === 0 ? undefined : out;
}
