import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useUiStore } from '../store/ui.js';
import { getIslandBridge } from './bridge.js';
import { IslandApp } from './IslandApp.js';
import '../styles.css';
import './island.css';

// Остров всегда тёмный (спека 2026-10-12, 5.2): класс `dark` и тёмные значки провайдеров.
useUiStore.getState().setDark(true);

const container = document.getElementById('root');
if (container === null) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <IslandApp bridge={getIslandBridge()} />
  </StrictMode>,
);
