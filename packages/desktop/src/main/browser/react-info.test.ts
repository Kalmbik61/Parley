// packages/desktop/src/main/browser/react-info.test.ts
import { describe, expect, it } from 'vitest';
import { parseReactInfo, REACT_INFO_FN, REACT_LIMITS } from './react-info.js';

/** Функция страницы, как её исполнит Runtime.callFunctionOn: `this` — узел. */
function run(node: object): unknown {
  const fn = new Function(`return (${REACT_INFO_FN});`)() as (this: object) => unknown;
  return fn.call(node);
}

function SettingsPage(): null {
  return null;
}
function SettingsForm(): null {
  return null;
}
function SaveButton(): null {
  return null;
}

/** Волокна React 18: у каждого `_debugSource` — место JSX, где оно создано. */
function react18(): object {
  const page = { type: SettingsPage, return: null };
  const main = { type: 'main', return: page, _debugSource: { fileName: 'src/SettingsPage.tsx', lineNumber: 3 } };
  const form = { type: SettingsForm, return: main, _debugSource: { fileName: 'src/SettingsPage.tsx', lineNumber: 4 } };
  const formElement = { type: 'form', return: form, _debugSource: { fileName: 'src/SettingsForm.tsx', lineNumber: 5 } };
  const save = { type: SaveButton, return: formElement, _debugSource: { fileName: 'src/SettingsForm.tsx', lineNumber: 6 } };
  return { type: 'button', return: save, _debugSource: { fileName: 'src/components/SaveButton.tsx', lineNumber: 12 } };
}

/** Кнопка React 19: `_debugStack` — объект Error, строки стека — как в отчёте этапа 0 (0.6). */
function react19(stack: string[]): object {
  return { type: 'button', return: { type: SaveButton, return: null }, _debugStack: { stack: stack.join('\n') } };
}

describe('REACT_INFO_FN (спека браузера 3.8; поиск компонента — по Orca)', () => {
  it('React 18: до трёх компонентов вверх по return; источник — место в файле компонента, где он нарисовал узел ниже', () => {
    const chain = [
      { name: 'SaveButton', source: 'src/components/SaveButton.tsx:12', approx: false },
      { name: 'SettingsForm', source: 'src/SettingsForm.tsx:5', approx: false },
      { name: 'SettingsPage', source: 'src/SettingsPage.tsx:3', approx: false },
    ];
    expect(run({ __reactFiber$abc: react18() })).toEqual(chain);
    // React 16 и 17 держат волокно под другим ключом (Orca getFiberFromElement).
    expect(run({ __reactInternalInstance$abc: react18() })).toEqual(chain);
  });

  it('по Orca: имя forwardRef — из render, memo — из type; точные имена каркаса и контексты пропущены, ClientList и ButtonWrapper — нет', () => {
    function ClientList(): null {
      return null;
    }
    function ButtonWrapper(): null {
      return null;
    }
    function Field(): null {
      return null;
    }
    const memo = { type: { $$typeof: Symbol.for('react.memo'), type: ButtonWrapper }, return: null };
    const provider = { type: { $$typeof: Symbol.for('react.memo'), displayName: 'Theme.Provider', type: Field }, return: memo };
    const forward = { type: { $$typeof: Symbol.for('react.forward_ref'), render: ClientList }, return: provider };
    const context = { type: { $$typeof: Symbol.for('react.context'), displayName: 'ThemeContext' }, return: forward };
    expect(run({ __reactFiber$k: { type: 'input', return: context } })).toEqual([
      { name: 'ClientList', source: null, approx: false },
      { name: 'ButtonWrapper', source: null, approx: false },
    ]);
  });

  it('React 19: правило parseDebugStack этапа 0 — кадры jsxDEV и пакетов React пропущены, путь без origin и query, approx', () => {
    // Бандл без карты исходников (стек из отчёта этапа 0, 0.6): позиция в бандле.
    expect(
      run({
        __reactFiber$x: react19([
          'Error: react-stack-top-frame',
          '    at exports.jsxDEV (http://127.0.0.1:60724/app19.js:23792:33)',
          '    at SaveButton (http://127.0.0.1:60724/app19.js:23824:62)',
          '    at Object.react_stack_bottom_frame (http://127.0.0.1:60724/app19.js:21557:22)',
        ]),
      }),
    ).toEqual([{ name: 'SaveButton', source: 'app19.js:23824', approx: true }]);
    // Dev-сервер с модулями (Vite): кадр рантайма JSX из node_modules пропущен, query модуля снят.
    expect(
      run({
        __reactFiber$x: react19([
          'Error: react-stack-top-frame',
          '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)',
          '    at SaveButton (http://localhost:5173/src/components/SaveButton.tsx?t=17:12:10)',
        ]),
      }),
    ).toEqual([{ name: 'SaveButton', source: 'src/components/SaveButton.tsx:12', approx: true }]);
  });

  it('нет React — null; ловушка страницы в свойстве — null, без исключения', () => {
    expect(run({ id: 'save' })).toBeNull();
    const trap = {};
    Object.defineProperty(trap, '__reactFiber$x', {
      enumerable: true,
      get() {
        throw new Error('page trap');
      },
    });
    expect(run(trap)).toBeNull();
  });
});

describe('parseReactInfo', () => {
  it('форма проверена: не больше трёх, имя до 100, источник до 300, approx — только true', () => {
    const value = [
      { name: 'A'.repeat(150), source: 's'.repeat(400), approx: 'yes' },
      { name: '', source: 'x' },
      { name: 'B', source: null, approx: true },
      { name: 'C', source: 5 },
      { name: 'D' },
    ];
    expect(parseReactInfo(value)).toEqual([
      { name: 'A'.repeat(REACT_LIMITS.name), source: 's'.repeat(REACT_LIMITS.source), approx: false },
      { name: 'B', source: null, approx: true },
    ]);
  });

  it('не массив или пусто — undefined', () => {
    for (const value of [null, 'x', {}, [], [{ name: '' }]]) expect(parseReactInfo(value), JSON.stringify(value)).toBeUndefined();
  });
});
