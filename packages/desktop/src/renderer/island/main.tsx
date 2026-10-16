import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useUiStore } from '../store/ui.js';
import { getIslandBridge } from './bridge.js';
import { IslandApp } from './IslandApp.js';
import { IslandErrorBoundary } from './IslandErrorBoundary.js';
import '../styles.css';
import './island.css';

// Остров всегда тёмный (спека 2026-10-12, 5.2): класс `dark` и тёмные значки провайдеров.
useUiStore.getState().setDark(true);

const container = document.getElementById('root');
if (container === null) throw new Error('#root not found');

const bridge = getIslandBridge();

// Упавшая отрисовка: граница сообщает main (`island:failed`), тот прячет окно и возвращает системные уведомления.
createRoot(container).render(
  <StrictMode>
    <IslandErrorBoundary api={bridge.island}>
      <IslandApp bridge={bridge} />
    </IslandErrorBoundary>
  </StrictMode>,
);
