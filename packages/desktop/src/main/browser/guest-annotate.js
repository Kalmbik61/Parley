// packages/desktop/src/main/browser/guest-annotate.js
// Слой меток — адаптация Orca `src/shared/browser-annotation-viewport-bridge.ts` (stablyai/orca b1cd858, MIT).
// Copyright (c) 2026 Lovecast Inc.; полный текст лицензии — в NOTICE в корне репозитория.
//
// Скрипт аннотаций (спека браузера 4.7). Main ставит его вслед за `guest-dom.js` одной строкой в изолированный мир 1001
// (annotate.ts) — тот же мир, что у guest-pick.js: страница не видит его переменных и не может ни поставить метку за
// человека, ни снять её. DOM общий: всё, что скрипт отдаёт, — данные страницы, main их проверяет
// (annotate.ts#validateAnnotationPick).
//
// Метки живут дольше одного вызова: первый запуск кладёт в мир объект `globalThis.__parleyAnnotate`, следующие берут
// его. Значение строки — промис одной метки: клик — метка на элементе, протяжка больше 4 px — рамка области, клик по
// номеру готовой метки — её правка, Esc — null и режим выключен.
//
// Слой меток — как у Orca: хост `position: fixed` с `pointer-events: none` и закрытым shadow-корнем (страница меток не
// видит и стилями их не задевает), положение пересчитывается раз в кадр (requestAnimationFrame) на прокрутке любого
// контейнера (capture) и на ресайзе, метки за краем вьюпорта спрятаны. Отличия от Orca:
// - метка на элементе стоит по живому getBoundingClientRect() своего элемента (по ключу), а не по прямоугольнику
//   документа, снятому при создании: так она идёт и за элементом во вложенном прокручиваемом контейнере; рамка
//   области — в координатах документа (спека 4.7);
// - мир 1001, без токена и без console.debug: инспектор пишет все console.* страницы в журнал Console человека;
// - на beforeunload слой не снимается: мир умирает вместе с документом, а скачивание и отменённый переход документ не
//   меняют — метки должны остаться;
// - у цели есть рамка (у элемента сплошная, у области пунктир), номер — кружок с центром в её левом верхнем углу, прижатый
//   внутрь вьюпорта (у цели вплотную к краю иначе слой обрезал бы его); скрытый display:none элемент — пропавший.
(() => {
  if (globalThis.__parleyAnnotate === undefined) {
    // Помощники DOM — guest-dom.js в той же строке перед этим файлом (задача 2).
    const dom = globalThis.__parleyDom;
    // HTML метки — CONTEXT_LIMITS.annotationHtml (1 КБ, спека 4.7): в пачке до 20 меток. main проверяет его заново.
    const MAX_HTML = 1024;
    const MAX_UNDER = 3;
    const DRAG_PX = 4;
    const BADGE_PX = 24;
    const COLOR = '#f59e0b';
    // Ключевые стили метки (спека 4.7): короче, чем у Select.
    const STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-size', 'font-weight'];
    // mousedown и mouseup ведут жест сами; остальное гасится, чтобы клик не сработал на странице.
    const BLOCKED = ['click', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'];
    // Эти два страница не получает, но отменять их нельзя: pointerdown с preventDefault отменяет и последующие mousedown,
    // mousemove и mouseup (совместимые события мыши, Pointer Events), а жест ведут именно они — метка не ставилась бы.
    const HIDDEN_ONLY = ['pointerdown', 'pointerup'];
    const LAYER_CSS =
      `.outline{position:absolute;left:0;top:0;box-sizing:border-box;border:2px solid ${COLOR};border-radius:2px;will-change:transform;}` +
      '.outline.region{border-style:dashed;}' +
      `.badge{position:absolute;left:0;top:0;box-sizing:border-box;width:${BADGE_PX}px;height:${BADGE_PX}px;display:flex;` +
      `align-items:center;justify-content:center;border-radius:9999px;border:1px solid rgba(255,255,255,0.95);background:${COLOR};` +
      'color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 24px rgba(0,0,0,.18);' +
      'will-change:transform;user-select:none;}';

    // Рамка протяжки — пока человек тянет; вне слоя, чтобы рисоваться без кадра.
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;display:none;box-sizing:border-box;border:2px dashed ${COLOR};z-index:2147483647;pointer-events:none;`;

    const targets = new Map(); // ключ → { el } у элемента или { rect } у рамки (координаты документа)
    const nodes = new Map(); // ключ → { outline, badge } в shadow-корне
    let host = null;
    let root = null;
    let pins = []; // [{ n, key }] — по лотку окна (sync)
    let provisional = null; // новая метка до ответа окна
    let seq = 0;
    let armed = false;
    let pending = null;
    let down = null;
    let dragging = false;
    let frame = 0;

    /** Хост слоя: `position: fixed` на весь вьюпорт, закрытый shadow-корень (Orca ensureOverlay). */
    function ensureLayer() {
      if (host === null) {
        host = document.createElement('div');
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style paint;overflow:hidden;';
        root = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = LAYER_CSS;
        root.appendChild(style);
      }
      // Страница могла вынуть хост из DOM (перерисовала body) — вернуть.
      const parent = document.body || document.documentElement;
      if (!host.isConnected && parent) parent.appendChild(host);
    }

    /**
     * Прямоугольник цели во вьюпорте: элемент — живой, рамка — из координат документа. Элемента больше нет в DOM или он
     * скрыт (display:none: вкладка, v-show, свёрнутый блок) — null: у скрытого узла коробок нет, а getBoundingClientRect
     * даёт нули в (0, 0), и метка торчала бы в углу вьюпорта.
     */
    function viewRect(key) {
      const target = targets.get(key);
      if (target === undefined) return null;
      if (target.rect !== undefined) {
        return { x: target.rect.x - window.scrollX, y: target.rect.y - window.scrollY, width: target.rect.width, height: target.rect.height };
      }
      if (!target.el.isConnected || target.el.getClientRects().length === 0) return null;
      const r = target.el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }

    /** Цель хотя бы краем во вьюпорте: иначе метка спрятана (Orca positionMarkers). */
    function inView(rect) {
      return rect !== null && rect.x + rect.width >= 0 && rect.y + rect.height >= 0 && rect.x <= window.innerWidth && rect.y <= window.innerHeight;
    }

    /**
     * Левый верхний угол кружка: центр на левом верхнем углу цели, но кружок целиком во вьюпорте. У цели вплотную к краю
     * (шапка, боковая панель, main, body) слой с overflow:hidden обрезал бы его, и номера не было бы видно ни на странице,
     * ни на снимке для агента. Клик по номеру (hitPin) считается по тому же месту.
     */
    function badgeAt(rect) {
      return {
        x: Math.max(0, Math.min(rect.x - BADGE_PX / 2, window.innerWidth - BADGE_PX)),
        y: Math.max(0, Math.min(rect.y - BADGE_PX / 2, window.innerHeight - BADGE_PX)),
      };
    }

    function shown() {
      return provisional === null ? pins : [...pins, provisional];
    }

    /** Положение меток по живым прямоугольникам; без элемента и за краем вьюпорта — спрятаны (Orca positionMarkers). */
    function positionMarkers() {
      for (const pin of shown()) {
        const node = nodes.get(pin.key);
        if (node === undefined) continue;
        const rect = viewRect(pin.key);
        const visible = inView(rect);
        node.outline.style.display = visible ? 'block' : 'none';
        node.badge.style.display = visible ? 'flex' : 'none';
        if (!visible) continue;
        node.outline.style.width = `${rect.width}px`;
        node.outline.style.height = `${rect.height}px`;
        node.outline.style.transform = `translate3d(${rect.x}px,${rect.y}px,0)`;
        const at = badgeAt(rect);
        node.badge.style.transform = `translate3d(${at.x}px,${at.y}px,0)`;
      }
    }

    /** Узлы меток по списку: новые созданы, лишние убраны, номера обновлены; меток нет — хост вынут (Orca updateMarkers). */
    function updateMarkers() {
      const list = shown();
      if (list.length === 0) {
        for (const node of nodes.values()) {
          node.outline.remove();
          node.badge.remove();
        }
        nodes.clear();
        if (host !== null) host.remove();
        return;
      }
      ensureLayer();
      const live = new Set();
      for (const pin of list) {
        live.add(pin.key);
        let node = nodes.get(pin.key);
        if (node === undefined) {
          const outline = document.createElement('div');
          outline.className = targets.get(pin.key).rect === undefined ? 'outline' : 'outline region';
          const badge = document.createElement('span');
          badge.className = 'badge';
          root.append(outline, badge);
          node = { outline, badge };
          nodes.set(pin.key, node);
        }
        node.badge.textContent = String(pin.n);
        node.badge.dataset.pin = String(pin.n);
      }
      for (const [key, node] of nodes) {
        if (live.has(key)) continue;
        node.outline.remove();
        node.badge.remove();
        nodes.delete(key);
      }
      positionMarkers();
    }

    /** Прокрутка любого контейнера и ресайз: положение — раз в кадр (Orca requestUpdate). */
    function requestUpdate() {
      if (frame !== 0 || nodes.size === 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        positionMarkers();
      });
    }

    function own(el) {
      return el === host || el === box;
    }

    function viewport() {
      return { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio };
    }

    function anchor(x, y) {
      return { fx: x / window.innerWidth, fy: y / window.innerHeight };
    }

    function settle(value) {
      const resolve = pending;
      pending = null;
      if (resolve !== null) resolve(value);
    }

    /** Новая цель: ключ в мире скрипта и временный номер, пока окно не перерисует метки по лотку (sync). */
    function remember(target) {
      seq += 1;
      const key = `a${seq}`;
      targets.set(key, target);
      provisional = { n: pins.length + 1, key };
      updateMarkers();
      return key;
    }

    /** Номер готовой метки под точкой: кружок BADGE_PX там, где он нарисован (badgeAt); спрятанная метка не кликается. */
    function hitPin(x, y) {
      for (const pin of pins) {
        const rect = viewRect(pin.key);
        if (!inView(rect)) continue;
        const at = badgeAt(rect);
        if (x >= at.x && x <= at.x + BADGE_PX && y >= at.y && y <= at.y + BADGE_PX) return pin.n;
      }
      return null;
    }

    function pinElement(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el || own(el)) return null;
      const key = remember({ el });
      return {
        kind: 'element',
        key,
        selector: dom.selectorOf(el),
        text: dom.textOf(el),
        html: dom.htmlOf(el, MAX_HTML),
        styles: dom.stylesOf(el, STYLE_KEYS),
        point: { x, y },
        // Прокрутка документа: main ищет узел по точке документа (DOM.getNodeForLocation, спайк 0.4).
        scroll: { x: window.scrollX, y: window.scrollY },
        anchor: anchor(x, y),
        viewport: viewport(),
      };
    }

    function pinRegion(x0, y0, x1, y1) {
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const width = Math.abs(x1 - x0);
      const height = Math.abs(y1 - y0);
      const elements = [];
      for (const el of document.elementsFromPoint(left + width / 2, top + height / 2)) {
        if (elements.length >= MAX_UNDER) break;
        if (own(el) || el === document.documentElement || el === document.body) continue;
        elements.push({ selector: dom.selectorOf(el), text: dom.textOf(el) });
      }
      const rect = { x: left + window.scrollX, y: top + window.scrollY, width, height };
      const key = remember({ rect });
      return { kind: 'region', key, rect, elements, anchor: anchor(left, top), viewport: viewport() };
    }

    function block(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function onBlocked(event) {
      // Событие, созданное страницей, не ставит метку и не гасится: метки ставит только человек.
      if (!event.isTrusted) return;
      if (HIDDEN_ONLY.includes(event.type)) event.stopImmediatePropagation();
      else block(event);
    }

    function onDown(event) {
      if (!event.isTrusted) return;
      block(event);
      if (event.button !== 0) return;
      down = { x: event.clientX, y: event.clientY };
      dragging = false;
    }

    function onMove(event) {
      if (!event.isTrusted || down === null) return;
      if (!dragging && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= DRAG_PX) return;
      dragging = true;
      if (!box.isConnected) document.documentElement.appendChild(box);
      box.style.display = 'block';
      box.style.left = `${Math.min(down.x, event.clientX)}px`;
      box.style.top = `${Math.min(down.y, event.clientY)}px`;
      box.style.width = `${Math.abs(event.clientX - down.x)}px`;
      box.style.height = `${Math.abs(event.clientY - down.y)}px`;
    }

    function onUp(event) {
      if (!event.isTrusted) return;
      block(event);
      if (event.button !== 0 || down === null) return;
      const start = down;
      const region = dragging || Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_PX;
      down = null;
      dragging = false;
      box.style.display = 'none';
      // Режим включён, а метка уже отдана окну (открыт редактор): жест гасится и ничего не ставит.
      if (pending === null) return;
      if (region) {
        settle(pinRegion(start.x, start.y, event.clientX, event.clientY));
        return;
      }
      const n = hitPin(event.clientX, event.clientY);
      if (n !== null) {
        settle({ kind: 'edit', n });
        return;
      }
      const pick = pinElement(event.clientX, event.clientY);
      if (pick !== null) settle(pick);
    }

    function onKey(event) {
      if (!event.isTrusted || event.key !== 'Escape') return;
      block(event);
      settle(null);
      disarm();
    }

    function arm() {
      if (armed) return;
      armed = true;
      for (const type of BLOCKED) window.addEventListener(type, onBlocked, true);
      window.addEventListener('mousedown', onDown, true);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
    }

    function disarm() {
      if (!armed) return;
      armed = false;
      for (const type of BLOCKED) window.removeEventListener(type, onBlocked, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      down = null;
      dragging = false;
      box.style.display = 'none';
    }

    // Метки идут за элементами: прокрутка любого контейнера (capture) и ресайз — пересчёт в следующем кадре.
    window.addEventListener('scroll', requestUpdate, true);
    window.addEventListener('resize', requestUpdate);

    globalThis.__parleyAnnotate = {
      pick() {
        arm();
        settle(null);
        return new Promise((resolve) => {
          pending = resolve;
        });
      },
      cancel() {
        settle(null);
        disarm();
      },
      sync(list) {
        pins = list.filter((pin) => targets.has(pin.key));
        provisional = null;
        updateMarkers();
        return list.map((pin) => {
          const rect = viewRect(pin.key);
          if (rect === null) return { n: pin.n, rect: null };
          return {
            n: pin.n,
            rect: { x: rect.x / window.innerWidth, y: rect.y / window.innerHeight, width: rect.width / window.innerWidth, height: rect.height / window.innerHeight },
          };
        });
      },
      count() {
        return pins.filter((pin) => viewRect(pin.key) !== null).length;
      },
      armed() {
        return armed;
      },
      waiting() {
        return pending !== null;
      },
    };
  }
  return globalThis.__parleyAnnotate.pick();
})();
