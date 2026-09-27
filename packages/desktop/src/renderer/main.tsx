import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { useUiStore } from './store/ui.js';
import { watchSystemDark } from './theme/appearance.js';
import { TOOLTIP_DELAY_MS, TooltipProvider } from './ui/tooltip.js';
import './styles.css';

// До первого кадра React — иначе первая отрисовка идёт в исходной светлой
// теме и в тёмной системе на старте мелькает белый экран (спека 4.7). Сама
// тёмность в сторе уже посчитана верно (`store/ui.ts`), здесь только
// применяем её к DOM и дальше следим за сменой системной темы на лету.
useUiStore.getState().setDark(useUiStore.getState().dark);
watchSystemDark((dark) => useUiStore.getState().setDark(dark));

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
