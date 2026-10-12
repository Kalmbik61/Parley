// Адаптация Orca `src/main/browser/grab-guest-foundation-script.ts`, `grab-guest-content-script.ts` и
// `grab-guest-element-context-script.ts` (stablyai/orca b1cd858, MIT). Copyright (c) 2026 Lovecast Inc.; полный текст
// лицензии — в NOTICE в корне репозитория.
//
// Помощники DOM для скриптов выбора и меток (`guest-pick.js`, `guest-annotate.js`; этап B браузера). Main ставит этот
// файл в одну строку перед скриптом режима и исполняет её в изолированном мире 1001 (`PICK_WORLD_ID`): мир не видит
// скриптов страницы, страница — его переменных, поэтому подменить помощники она не может. У Orca те же функции живут в
// главном мире страницы; сюда перенесена только DOM-часть, она одинаково работает в любом мире. Всё, что помощники
// достают, — данные страницы: main проверяет форму и длины заново (`validatePick`, `validateAnnotationPick`).
//
// Что взято у Orca и что изменено:
// - selectorOf — `buildSelector` с помощниками: кратчайший уникальный суффикс пути, до двух «устойчивых» классов на
//   звено (хэши CSS-modules и `css-xxxx` отброшены), `:nth-of-type` — только когда без него звено не уникально. Порядок
//   звеньев в проверке уникальности исправлен (у Orca с третьего звена проверялась строка в другом порядке). Проверки
//   `containsSecret` нет: маска у Parley одна — `shared/redact.ts`. Пределы — `PICK_LIMITS`, а не `GRAB_BUDGET`;
// - textOf — `getBoundedText`: обход не больше 80 текстовых узлов без регулярок по всему тексту; текст `script`,
//   `style`, `noscript` и `template` не читается. Пометки « (truncated)» нет: её ставит main;
// - htmlOf — прежняя `cleanHtml` Parley (без `script`, `style`, `on*`, `srcdoc` и значений секретных полей) плюс мысль
//   `getSafeAttributes` и `sanitizeUrl` Orca: у `href`, `src` и `action` снимаются query и hash, чужая схема
//   (`javascript:`, `data:`) — пустая строка;
// - stylesOf — вычисленные стили по списку ключей вызывающего (23 у Select, 10 у метки).
//
// Файл — одно выражение без значения: значение строки даёт скрипт режима, который стоит после него.
(() => {
  if (globalThis.__parleyDom !== undefined) return;

  // Зеркало PICK_LIMITS (main/browser/design-mode.ts), его сверяет guest-dom.test.ts: лишнее отсюда не везём.
  const LIMITS = Object.freeze({ selectorLinks: 12, selector: 1024, text: 500, html: 4096 });
  const TEXT_NODES = 80;
  const CLASSES_PER_LINK = 2;
  const CLASS_LENGTH = 60;
  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const URL_ATTRIBUTES = new Set(['href', 'src', 'action']);
  const SAFE_SCHEMES = new Set(['http', 'https', 'file']);
  // Поля, чьё value уходить агенту не должно: пароли, CSRF-токены, карты, одноразовые коды.
  const SECRET_AUTOCOMPLETE = /^(cc-.*|one-time-code|.*-password)$/i;

  /** Класс, похожий на хэш сборщика (CSS-modules, styled-components): со сборкой он сменится. */
  function looksHashy(name) {
    return /^[A-Za-z0-9_-]{12,}$/.test(name) && /\d/.test(name) && /[A-Z]/.test(name);
  }

  function stableClasses(el) {
    const out = [];
    for (const name of Array.from(el.classList || [])) {
      if (out.length >= CLASSES_PER_LINK) break;
      if (name.length > CLASS_LENGTH || /^css-[a-z0-9]+$/i.test(name) || looksHashy(name)) continue;
      out.push(name);
    }
    return out;
  }

  function linkOf(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${CSS.escape(el.id)}`;
    return tag + stableClasses(el).map((name) => `.${CSS.escape(name)}`).join('');
  }

  function unique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function nthOfType(el) {
    let index = 1;
    for (let node = el.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.tagName === el.tagName) index += 1;
    }
    if (index > 1) return `:nth-of-type(${index})`;
    for (let node = el.nextElementSibling; node; node = node.nextElementSibling) {
      if (node.tagName === el.tagName) return ':nth-of-type(1)';
    }
    return '';
  }

  /** Кратчайший уникальный суффикс пути от элемента вверх: не больше LIMITS.selectorLinks звеньев, до `body`. */
  function selectorOf(el) {
    const links = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body && links.length < LIMITS.selectorLinks; node = node.parentElement) {
      let link = linkOf(node);
      if (node.parentElement && !unique([link, ...links].join(' > '))) link += nthOfType(node);
      links.unshift(link);
      const selector = links.join(' > ');
      if (unique(selector)) return selector.slice(0, LIMITS.selector);
    }
    return (links.join(' > ') || el.tagName.toLowerCase()).slice(0, LIMITS.selector);
  }

  function isSpace(code) {
    return (
      code === 32 ||
      (code >= 9 && code <= 13) ||
      code === 160 ||
      code === 5760 ||
      (code >= 8192 && code <= 8202) ||
      code === 8232 ||
      code === 8233 ||
      code === 8239 ||
      code === 8287 ||
      code === 12288 ||
      code === 65279
    );
  }

  /** Текст элемента: не больше TEXT_NODES текстовых узлов, пробелы схлопнуты, узлы разделены пробелом, до LIMITS.text. */
  function textOf(el) {
    let text = '';
    let space = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement !== null && SKIP_TEXT.has(node.parentElement.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(), seen = 1; node !== null && seen <= TEXT_NODES && text.length < LIMITS.text; node = walker.nextNode(), seen += 1) {
      if (text !== '') space = true;
      const value = node.nodeValue || '';
      for (let index = 0; index < value.length && text.length < LIMITS.text; index += 1) {
        if (isSpace(value.charCodeAt(index))) {
          if (text !== '') space = true;
          continue;
        }
        if (space) {
          if (text.length + 1 >= LIMITS.text) return text;
          text += ' ';
          space = false;
        }
        text += value.charAt(index);
      }
    }
    return text;
  }

  function isSecretField(el) {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'password' || type === 'hidden')) return true;
    const tokens = (el.getAttribute('autocomplete') || '').split(/\s+/);
    return tokens.some((token) => SECRET_AUTOCOMPLETE.test(token));
  }

  /** URL атрибута без query и hash; схема не http, https или file — пустая строка (`sanitizeUrl` Orca). */
  function cleanUrl(value) {
    const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value);
    if (scheme !== null && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return '';
    return value.replace(/[?#][\s\S]*$/, '');
  }

  /** HTML элемента без скриптов, обработчиков и секретов полей; на символ длиннее `max` — так main видит обрезку. */
  function htmlOf(el, max) {
    const clone = el.cloneNode(true);
    for (const node of clone.querySelectorAll('script, style')) node.remove();
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') node.removeAttribute(attr.name);
        else if (URL_ATTRIBUTES.has(name)) node.setAttribute(attr.name, cleanUrl(attr.value));
      }
      if (isSecretField(node)) {
        node.removeAttribute('value');
        if (node.tagName.toLowerCase() === 'textarea') node.textContent = '';
      }
    }
    return clone.outerHTML.slice(0, max + 1);
  }

  /** Вычисленные стили по списку ключей (kebab-case). */
  function stylesOf(el, keys) {
    const computed = getComputedStyle(el);
    const styles = {};
    for (const key of keys) styles[key] = computed.getPropertyValue(key);
    return styles;
  }

  globalThis.__parleyDom = Object.freeze({ LIMITS, selectorOf, textOf, htmlOf, stylesOf });
})();
