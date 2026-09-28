import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { getHostClient } from './host-client.js';
import { useUiStore } from './store/ui.js';
import { followAppearance } from './theme/appearance.js';
import { TOOLTIP_DELAY_MS, TooltipProvider } from './ui/tooltip.js';
import './styles.css';

// До первого кадра React — иначе первая отрисовка идёт в исходной светлой
// теме и в тёмной системе на старте мелькает белый экран (спека 4.7). Тёмность —
// по `nativeTheme` main (раунд main-r2, п. 1): начальная синхронно, дальше — каждая
// смена, в том числе выбор «Theme: …» в палитре и Settings.
followAppearance(getHostClient(), (dark) => useUiStore.getState().setDark(dark));

const container = document.getElementById('root');
if (container === null) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    {/* Один провайдер на всё окно (раунд исправлений 1, находка ревью B №4) —
        иначе тултипы теряют общий skipDelayDuration Radix между собой. */}
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
