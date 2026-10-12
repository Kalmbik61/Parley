// Скрипт выбора элемента Design Mode (кусок 9.3a, спека 12.3). Main исполняет его в госте через
// executeJavaScriptInIsolatedWorld(PICK_WORLD_ID): изолированный мир не видит скриптов страницы, а
// страница — его переменных, так что подделать выбор или позвать отмену она не может. DOM общий:
// всё, что скрипт отсюда отдаёт, — данные страницы, и main их заново проверяет (validatePick).
//
// Main ставит перед ним `guest-dom.js` в ту же строку (помощники DOM `globalThis.__parleyDom`, этап B браузера):
// значение строки — значение этого файла, промис, который Electron дождётся и отдаст main. По клику
// человека — данные элемента, по Esc или отмене — null.
(() => {
  // Новый выбор того же гостя снимает прежний: два оверлея и два набора перехватчиков не нужны.
  if (typeof globalThis.__parleyPickCancel === 'function') globalThis.__parleyPickCancel();

  // Помощники DOM — guest-dom.js в той же строке перед этим файлом (этап B браузера, задача 2).
  const dom = globalThis.__parleyDom;
  const STYLE_KEYS = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'border',
    'border-radius',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'text-align',
    'flex-direction',
    'justify-content',
    'align-items',
    'gap',
    'grid-template-columns',
    'box-shadow',
    'opacity',
  ];
  // Клик не должен сработать на странице: usePress React Aria и похожие ловят pointerup и mouseup.
  const BLOCKED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'];

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' +
    'border:2px solid #3b82f6;display:none;left:0;top:0;width:0;height:0;';
  const label = document.createElement('div');
  label.style.cssText =
    'position:absolute;left:-2px;bottom:100%;padding:1px 4px;background:#3b82f6;color:#fff;' +
    'font:11px/16px system-ui,sans-serif;white-space:nowrap;';
  overlay.appendChild(label);

  function shortName(el) {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
  }

  function highlight(el) {
    if (!el || el === overlay || overlay.contains(el)) return;
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    label.textContent = `${shortName(el)} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  }

  function dataOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      selector: dom.selectorOf(el),
      text: dom.textOf(el),
      // html — на символ больше предела: так main видит, что обрезано, и ставит свою пометку.
      html: dom.htmlOf(el, dom.LIMITS.html),
      styles: dom.stylesOf(el, STYLE_KEYS),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
    };
  }

  function fullyVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  }

  return new Promise((resolve) => {
    let done = false;

    function finish(value) {
      if (done) return;
      done = true;
      for (const type of BLOCKED) window.removeEventListener(type, onBlocked, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (globalThis.__parleyPickCancel === cancel) delete globalThis.__parleyPickCancel;
      if (value === null) {
        resolve(null);
        return;
      }
      // Снимок main делает после ответа: оверлей и прокрутка должны уже быть на экране — два кадра.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(value)));
    }

    function cancel() {
      finish(null);
    }

    function onMove(event) {
      if (!event.isTrusted) return;
      highlight(document.elementFromPoint(event.clientX, event.clientY));
    }

    function onBlocked(event) {
      // Событие, созданное страницей, не выбирает и не гасится: выбирает только человек.
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== 'click') return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || el === overlay || overlay.contains(el)) return;
      if (!fullyVisible(el)) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      finish(dataOf(el));
    }

    function onKey(event) {
      if (!event.isTrusted || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
    }

    globalThis.__parleyPickCancel = cancel;
    for (const type of BLOCKED) window.addEventListener(type, onBlocked, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    document.documentElement.appendChild(overlay);
  });
})();
