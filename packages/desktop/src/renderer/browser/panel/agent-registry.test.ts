// packages/desktop/src/renderer/browser/panel/agent-registry.test.ts
/**
 * Реестр страниц панелей для main (этап C, спека браузера 3.7, 3.10, 4.8): что регистрируется при гидрации, закрытии страницы
 * и паузе; повторов нет; вкладки человека не попадают никогда. Поверхность страницы (`BrowserSurface`) проверена в
 * `PanelSurface.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserOwner, WorkLayout } from '../../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { addPanelPage, closePanelPage, setPanelPaused } from '../../layout/panels.js';
import { useLayoutStore } from '../../layout/store.js';
import { emptyLayout, openTab } from '../../layout/tree.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { pausePanel } from './actions.js';
import { reportAgentPage, resetAgentRegistry, startAgentRegistry } from './agent-registry.js';

const WORK = '/tmp/proj w-01';
const OWNER: BrowserOwner = { kind: 'session', sessionId: 's-01' };

let bridge: FakeBridge;
let stop: () => void = () => undefined;

const registrations = (): unknown[] => bridge.browserCalls.filter((call) => call.method === 'registerTab').map((call) => call.args[0]);

function setLayout(layout: WorkLayout | null): void {
  useLayoutStore.setState({
    activeWorkKey: WORK,
    layouts: layout === null ? {} : { [WORK]: layout },
    hydrated: layout === null ? {} : { [WORK]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

/** Раскладка с панелью `OWNER` из страниц `ids`; подписка на раскладки стартует до гидрации, как в окне. */
function hydrateWithPanel(ids: string[], paused = false): void {
  let layout = emptyLayout();
  for (const id of ids) layout = addPanelPage(layout, OWNER, { id, url: 'http://localhost:3000/' }).layout;
  if (paused) layout = setPanelPaused(layout, OWNER, true);
  useLayoutStore.setState({ layouts: { [WORK]: layout }, hydrated: { [WORK]: true } });
}

const apply = (op: (layout: WorkLayout) => WorkLayout): void => {
  useLayoutStore.getState().apply(WORK, op);
};

beforeEach(() => {
  bridge = createFakeBridge();
  resetAgentRegistry();
  setLayout(null);
  stop = startAgentRegistry(bridge);
});

afterEach(() => {
  stop();
  setLayout(null);
});

describe('реестр страниц панелей для main (этап C, спека 3.7, 3.10)', () => {
  it('гидрация: страницы панели регистрируются без гостя; повторная раскладка того же состава ничего не шлёт', () => {
    hydrateWithPanel(['bp-aaaaaa', 'bp-bbbbbb']);
    expect(registrations()).toEqual([
      { webContentsId: null, workKey: WORK, owner: OWNER, pageId: 'bp-aaaaaa', visible: false },
      { webContentsId: null, workKey: WORK, owner: OWNER, pageId: 'bp-bbbbbb', visible: false },
    ]);
    useLayoutStore.setState({ navigating: false });
    expect(registrations()).toHaveLength(2);
  });

  it('reportAgentPage: гость и видимость доходят; тот же отчёт повторно не шлётся; подписчик отчёт поверхности не затирает', () => {
    hydrateWithPanel(['bp-aaaaaa']);
    reportAgentPage(bridge, WORK, OWNER, 'bp-aaaaaa', 7, true);
    reportAgentPage(bridge, WORK, OWNER, 'bp-aaaaaa', 7, true);
    useLayoutStore.setState({ navigating: false });
    expect(registrations().at(-1)).toEqual({ webContentsId: 7, workKey: WORK, owner: OWNER, pageId: 'bp-aaaaaa', visible: true });
    expect(registrations()).toHaveLength(2);
  });

  it('страница закрыта — gone по workKey и pageId; вкладка человека (browser:…) в реестр не попадает никогда', () => {
    hydrateWithPanel(['bp-aaaaaa', 'bp-bbbbbb']);
    apply((layout) => closePanelPage(layout, OWNER, 'bp-aaaaaa'));
    expect(registrations().at(-1)).toEqual({ workKey: WORK, pageId: 'bp-aaaaaa', gone: true });
    apply((layout) => openTab(layout, { kind: 'browser', id: 'browser:abc123', url: 'http://localhost:5173/' }, 'active'));
    expect(JSON.stringify(registrations())).not.toContain('browser:abc123');
  });

  it('пауза: смена шлётся один раз; гидрация с paused: true шлёт её; панель исчезла на паузе — paused: false', () => {
    hydrateWithPanel(['bp-aaaaaa'], true);
    expect(registrations()).toContainEqual({ workKey: WORK, owner: OWNER, paused: true });
    pausePanel(WORK, OWNER, false);
    pausePanel(WORK, OWNER, false);
    expect(registrations().filter((e) => typeof e === 'object' && e !== null && 'paused' in e)).toHaveLength(2);
    pausePanel(WORK, OWNER, true);
    apply((layout) => closePanelPage(layout, OWNER, 'bp-aaaaaa'));
    expect(registrations()).toContainEqual({ workKey: WORK, owner: OWNER, paused: false });
  });
});
