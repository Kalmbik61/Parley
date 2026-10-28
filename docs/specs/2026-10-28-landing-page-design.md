# Лендинг Parley на GitHub Pages — спека

**Дата:** 2026-10-28. **Статус:** реализовано (T1–T4 и правки ревью), ждёт коммита и PR. Ведущий — s-01 (Opus): спека, ревью, вердикт. Исполнитель — модель стандартного уровня (Sonnet), одна задача за раз (`PARLEY.md`, раздел Roles). Ветка `feat/landing-page` от `origin/master`, worktree `/Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/landing-page`. Push, PR и включение Pages — только по слову человека.

## 1. Цель и граница

Одностраничный сайт Parley по адресу `https://kalmbik61.github.io/Parley/`. Он объясняет, что такое Parley, показывает комнату в действии и все основные функции, говорит о ценностях проекта, выводит свежие релизы с GitHub (клик ведёт на страницу релиза, ссылка «All releases» — на список) и ведёт к установке.

- Статика: HTML, CSS и JS без фреймворков, библиотек и шага сборки. Папка `site/` публикуется как есть.
- Релизы попадают на страницу снимком `site/releases.json`. Его пишет workflow публикации токеном репозитория, и сайт перевыпускается после каждого релиза (§6, §10). Браузер посетителя в GitHub API не ходит: неавторизованный лимит — 60 запросов в час на IP, и при подготовке спеки мы сами в него упёрлись.
- Язык страницы — английский, как README, заметки к релизам и интерфейс.
- Вне объёма: русская версия, свой домен, аналитика, блог, переключатель темы в интерфейсе, правки README и CHANGELOG, push, включение Pages в настройках репозитория (это делает человек, §10).

## 2. Голос и ценности

Текст — §5, дословно. Исполнитель может переносить строки и укорачивать текст ради мобильной вёрстки только с сохранением смысла. Новых утверждений о продукте не добавлять.

- Тон README и заметок к релизам: короткие фразы, факты и числа. Без «revolutionary», «supercharge», «seamless», «AI-powered», «unleash», восклицательных знаков и эмодзи (💤 из заметок релиза допустим в тексте релиза, его выводит не страница, а GitHub).
- Любое утверждение о продукте взято из `README.md`, `CHANGELOG.md` или заметок релиза.
- Ценности, которые страница показывает:
  - решение за человеком;
  - свои CLI и подписки, без ключей API;
  - работа только локально, без телеметрии;
  - честность: у каждого релиза есть раздел «What is not proven yet».
- Сама страница им следует: никаких cookies, аналитики, сторонних шрифтов, CDN и запросов на другие сайты. Всё грузится с того же адреса.
- Знаки вендоров — по слову человека (пометки на странице, 2026-10-28): только файлы из `packages/desktop/src/renderer/assets/providers`, которые уже есть в окне и в NOTICE. Их копии лежат в `site/media/vendors/` вместе с `NOTICE.txt`: туда переносятся разделы корневого NOTICE «Значки провайдеров» и «LobeHub Icons» с текстом MIT. В подвале — видимая оговорка о товарных знаках (§5.13). У GLM знака в репозитории нет, он остаётся словом.
- В макетах продукта (комната, остров) — пример данных «shop / Payments / Refunds», как на скриншотах README.

## 3. Файлы

```
site/
  index.html
  styles.css
  js/
    main.js          точка входа: релизы, копирование команды, появление при прокрутке, год в подвале
    releases.js      чистые функции разбора релизов, без DOM; их гоняет Node
    room-demo.js     живая комната в hero (§7)
    island.js        остров в секции острова (§8)
  fonts/             Figtree-Variable.woff2, Caprasimo.woff2, Figtree-OFL.txt, Caprasimo-OFL.txt
  media/             room-decision-{light,dark}.webp, parley-demo.mp4, parley-demo-poster.webp, og-image.jpg
  favicon.svg
  favicon-32.png
  apple-touch-icon.png
  README.md          локальный просмотр, снимок релизов, пересборка медиа, публикация
scripts/site/
  releases.test.mjs  node:test для site/js/releases.js
  fixtures/releases.json
.github/workflows/pages.yml
packages/desktop/src/release-workflows.test.ts   ALLOWED_ACTIONS и блок для pages.yml
.gitignore                                       строка site/releases.json
```

- Сайт живёт под `/Parley/`, поэтому все пути в HTML, CSS и JS относительные: `styles.css`, `js/main.js`, `media/...`. Абсолютный URL только у `og:image`, `og:url` и `canonical`.
- JS — ES-модули (`<script type="module" src="js/main.js">`), без сборки. Синтаксис не новее ES2021: тест запускает Node 22, а `Object.groupBy` и похожие API не нужны.
- Код без зависимостей. `package.json` в `site/` не нужен: корневой `package.json` уже `"type": "module"`, и Node читает `site/js/releases.js` как модуль.

## 4. Визуальная система: облик Organic

Источник — `packages/desktop/src/renderer/styles/tokens.css` и handoff `docs/design/2026-09-29-rooms-organic/README.md`. Значения копируются в `site/styles.css`, импорта из пакета окна нет.

### 4.1 Токены

Объявить на `:root`. Тёмные значения — в двух местах с одинаковым телом: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` и `:root[data-theme="dark"] { … }`. Атрибут `data-theme` в интерфейсе не переключается. Он нужен, чтобы проверить тёмную тему одной строкой в консоли.

| Токен | Светлая | Тёмная | Назначение |
|---|---|---|---|
| `--bg` | `#f5ead8` | `#0e0d0c` | фон страницы |
| `--surface` | `#ebddc5` | `#161513` | фон чередующихся секций |
| `--card` | `#f9f4ed` | `#23211e` | карточки |
| `--window` | `#f9f4ed` | `#0b0a09` | лист макета комнаты |
| `--text` | `#201e1d` | `#ece6dc` | основной текст |
| `--muted` | `#645c50` | `#a8a095` | вторичный текст |
| `--accent` | `#c67139` | `#d67f48` | терракота: заливки, обводки |
| `--accent-text` | `#8c491a` | `#eea373` | терракота для мелкого текста: ссылки, eyebrow |
| `--accent-display` | `#b2622d` | `#dc8753` | терракота для крупного текста («You decide.») |
| `--accent-soft` | `#ffe1d0` | `#3a2314` | «needs you», тег question |
| `--accent-strong` | `#643312` | `#f8c39f` | текст на `--accent-soft`, чип упоминания |
| `--sage` | `#7a8a5e` | `#8fa073` | шалфей: заливки |
| `--sage-text` | `#56633f` | `#b5c697` | шалфей для текста |
| `--sage-soft` | `#e1eecc` | `#242b1a` | «done · unseen», тег decision |
| `--primary` | `#8c491a` | `#d67f48` | главная кнопка |
| `--primary-hover` | `#643312` | `#dc8753` | |
| `--on-primary` | `#f5ead8` | `#0e0d0c` | текст главной кнопки |
| `--divider` | `color-mix(in srgb, #201e1d 16%, transparent)` | `color-mix(in srgb, #ece6dc 14%, transparent)` | линии и рамки |
| `--logo-ink` | `#191814` | `#f2ebdd` | человек и надпись в логотипе |
| `--shadow-sm` | `0 1px 2px color-mix(in srgb, #2e2b25 14%, transparent)` | `0 0 0 1px color-mix(in srgb, #ece6dc 9%, transparent), 0 1px 2px rgb(0 0 0 / .5)` | |
| `--shadow-md` | `0 3px 10px color-mix(in srgb, #2e2b25 16%, transparent)` | `0 0 0 1px color-mix(in srgb, #ece6dc 9%, transparent), 0 4px 12px rgb(0 0 0 / .5)` | |
| `--shadow-lg` | `0 12px 32px color-mix(in srgb, #2e2b25 22%, transparent)` | `0 0 0 1px color-mix(in srgb, #ece6dc 10%, transparent), 0 12px 32px rgb(0 0 0 / .6)` | |

Рампы для мелочей (статусы, точки, тени) — `--neutral-100…900`: светлая `#f9f4ed #eee7db #dcd3c4 #c0b6a5 #a19786 #82796a #645c50 #474238 #2e2b25`, тёмная `#23211e #2c2926 #3b3732 #524d46 #6e675e #8b8479 #a8a095 #cbc4b9 #e9e3d9`.

Остров (§8) всегда чёрный в обеих темах: `--island: #000`, `--on-island: #f2ebdd`, приглушённый текст острова `#a8a095`.

Цвета логотипа постоянные: шалфей `#A9B78D`, терракота `#CF7847`, песочное золото `#C2A16D`.

Контраст: обычный текст и `--muted` на `--bg`, `--surface`, `--card` — не ниже 4.5:1; `--accent-display` — только для текста от 32px.

### 4.2 Типографика

- `--font-display: 'Caprasimo', Georgia, serif` — заголовки, крупные числа и подписи кнопок, как в окне.
- `--font-sans: 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` — текст.
- `--font-mono: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace` — команды, пути, `↑1.2M ↓84k`.
- `@font-face`: локальные woff2, `font-display: swap`. Figtree — вариативный, `font-weight: 400 700`. Caprasimo — один вес, 400; синтетический жирный ему не давать: `font-synthesis: none` на заголовках.
- `<link rel="preload" as="font" type="font/woff2" crossorigin>` для обоих шрифтов.
- H1 — `clamp(3rem, 1.6rem + 6vw, 6.5rem)` / 0.98, `letter-spacing: -0.02em`.
- H2 — `clamp(2.125rem, 1.4rem + 3vw, 3.75rem)` / 1.04, `-0.015em`.
- H3 — `clamp(1.375rem, 1.1rem + 1vw, 1.75rem)` / 1.15.
- Lead — `clamp(1.125rem, 1rem + 0.5vw, 1.375rem)` / 1.5, цвет `--muted`.
- Body — 17px / 1.6 (на ширине до 640px — 16px).
- Eyebrow — 13px, вес 600, капс, `letter-spacing: 0.08em`, цвет `--accent-text`.
- Длина строки текста — до 68ch.

### 4.3 Форма, отступы, сетка

- Кнопки, теги, пилюли, поля — `border-radius: 999px`. Карточки и окна — 28px, мелкие блоки внутри — 16px.
- Кнопка: шрифт display, 17px, высота 48px, отступы 0 24px; малая — 40px, 16px, отступы 0 18px. Главная: фон `--primary`, текст `--on-primary`, hover `--primary-hover`. Вторичная: прозрачная, рамка 1.5px `color-mix(in srgb, var(--text) 22%, transparent)`, hover — фон `color-mix(in srgb, var(--text) 6%, transparent)`.
- Тег: высота 24px, отступы 0 10px, 12px, вес 600. Варианты из окна: `question` — `--accent-soft` и `--accent-strong`; `decision` — `--sage-soft` и `--sage-text`; `note` — `--neutral-200` и `--muted`.
- Чип упоминания: `display: inline-block; padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent-strong); font-weight: 600; white-space: nowrap`.
- Клавиша: моноширинный 14px, отступы 2px 8px, радиус 8px, рамка 1px `--divider`, снизу тень `0 1px 0 var(--divider)`.
- Контейнер: `width: min(1180px, 100% - 2 * var(--gutter))`, `--gutter: clamp(16px, 4vw, 32px)`, по центру.
- Вертикальный отступ секции — `clamp(72px, 9vw, 128px)`.
- Секции чередуют фон `--bg` и `--surface`, остров — свой чёрный (§8).
- Точки перелома: 640px и 1024px. На 375px нет горизонтальной прокрутки страницы. Горизонтально прокручивается только лента участников в макете комнаты.

### 4.4 Мотив роя

Агент с логотипа — круг-голова и скруглённое тело. Взять из `docs/media/brand/parley-icon.svg` как `<symbol id="agent">`: `<circle cy="-184" r="22"/>` и путь `M-38-126C-38-145-24-157-13-154C-5-151 5-151 13-154C24-157 38-145 38-126Q38-122 34-122H-34Q-38-122-38-126Z`. Мотив появляется в двух местах:

- В hero за макетом комнаты — плавающие фигурки агентов, у которых вместо головы знак вендора (Claude, Codex, DeepSeek, Qwen, Kimi, MiniMax). Так решил человек в пометках на странице 2026-10-28, вместо вращающегося кольца из первой версии спеки. Правила для фигурок:
  - не больше восьми;
  - декоративные: `aria-hidden="true"`, `pointer-events: none`;
  - не заходят под текст и кнопки hero ни на 1440, ни на 375px;
  - при reduced motion неподвижны.
- На острове — рой из четырёх точек (§8).

### 4.5 Движение

- Появление при прокрутке: элементы с `data-reveal` проявляются (opacity 0→1, сдвиг 16px→0, 500ms, `cubic-bezier(.2,.7,.2,1)`) через `IntersectionObserver`, один раз. В сетках задержка 60ms на элемент.
- Наведение на карточку-ссылку: подъём на 2px и `--shadow-md`, 200ms.
- `prefers-reduced-motion: reduce` выключает вращение кольца, появление, анимации комнаты и острова (§7, §8). Всё видно сразу, кнопки работают.
- Без JS видно всё содержимое: классы, которые прячут элементы до появления, ставит только JS (`document.documentElement.classList.add('js')`).

### 4.6 Доступность

- Ориентиры: `header` с `nav`, `main`, секции с `aria-labelledby`, `footer`. Первая ссылка — «Skip to content».
- Фокус с клавиатуры: `outline: 2px solid var(--accent); outline-offset: 3px` через `:focus-visible`.
- Кнопки — `<button type="button">`, ссылки — `<a>`. Ссылки на внешние сайты открываются в той же вкладке.
- У картинок `alt`, у декоративных SVG `aria-hidden="true"`. У `img` и `video` заданы `width` и `height`.
- Лента макета комнаты — `role="log"`. Её озвучивают только сообщения, которые появляются после прокрутки к ней.

## 5. Секции и текст

Навигация по якорям: `#rooms`, `#island`, `#features`, `#principles`, `#releases`, `#install`. Ссылки:

- репозиторий — `https://github.com/Kalmbik61/Parley`;
- релизы — `https://github.com/Kalmbik61/Parley/releases`;
- CHANGELOG — `https://github.com/Kalmbik61/Parley/blob/master/CHANGELOG.md`;
- лицензия — `https://github.com/Kalmbik61/Parley/blob/master/LICENSE`;
- NOTICE — `https://github.com/Kalmbik61/Parley/blob/master/NOTICE`;
- dmg для Apple Silicon — `https://github.com/Kalmbik61/Parley/releases/latest/download/parley-macos-arm64.dmg`;
- dmg для Intel — `https://github.com/Kalmbik61/Parley/releases/latest/download/parley-macos-x64.dmg`.

### 5.0 `<head>`

- `<html lang="en">`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Title: `Parley — Your agents parley. You decide.`
- Description: `Parley is a free, open-source macOS app that puts Claude Code, Codex and GLM in one room. Agents discuss your task, a lead brings you one decision, and nothing starts until you accept it.`
- `canonical` и `og:url` — `https://kalmbik61.github.io/Parley/`.
- Open Graph: `og:type` website, `og:title` = title, `og:description` = description, `og:image` = `https://kalmbik61.github.io/Parley/media/og-image.jpg` (1200×630), `og:image:alt` `Parley — Your agents parley. You decide.`.
- Twitter: `twitter:card` summary_large_image.
- `<meta name="theme-color" content="#f5ead8" media="(prefers-color-scheme: light)">` и `#0e0d0c` для тёмной. `<meta name="color-scheme" content="light dark">`.
- Иконки: `favicon.svg` (`type="image/svg+xml"`), `favicon-32.png` (32×32), `apple-touch-icon.png` (180×180).
- JSON-LD `SoftwareApplication`: name Parley, operatingSystem `macOS 13 or later`, applicationCategory DeveloperApplication, offers price 0, license `https://opensource.org/licenses/MIT`, url сайта, downloadUrl — страница релизов.

### 5.1 Шапка (липкая)

Полупрозрачный фон `color-mix(in srgb, var(--bg) 82%, transparent)` и `backdrop-filter: blur(12px)`. Нижняя линия `--divider` появляется после прокрутки на 8px (класс от JS).

- Слева — логотип: inline SVG `docs/media/brand/parley-logo-light.svg`, высота 32px. Человек и надпись — `fill: var(--logo-ink)`, остальные цвета как в файле. Ссылка на верх страницы, `aria-label="Parley"`.
- Ссылки (от 1024px): `Rooms` `Island` `Features` `Principles` `Releases`.
- Справа: `GitHub` — вторичная малая кнопка, ведёт на репозиторий; `Download` — главная малая кнопка, ведёт на `#install`.
- Ниже 1024px остаются логотип и две кнопки; ниже 400px кнопка GitHub прячется.

### 5.2 Hero

Фон: `radial-gradient(ellipse 70% 55% at 50% -10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)` поверх `--bg`. Всё по центру.

1. Пилюля новостей — ссылка на страницу последнего релиза. Текст `New in 0.24.0 — ` и первая фраза описания релиза, не длиннее 72 символов (§6.3), справа `→`. Без JS и без снимка: `See what's new in the latest release →`, ссылка `…/releases/latest`.
2. H1 в две строки: `Your agents parley.` / `You decide.` Вторая строка — цвет `--accent-display`.
3. Lead (до 640px шириной): `Parley is a free, open-source Mac app that puts Claude Code, Codex and GLM in one room. They discuss your task, a lead brings you one decision, and no work starts until you accept it.`
4. Кнопки: `Download for Mac` (главная, ведёт на `#install`) и `View on GitHub` (вторичная).
5. Строка мелким `--muted`: `Free · MIT license · macOS 13 or later`. С JS к ней спереди добавляется `Latest v0.24.0 · ` — версия ссылкой на релиз.
6. Пилюли ценностей (как на обложке проекта): `Local-only` · `Your own claude, codex & GLM` · `No API keys` · `No telemetry`.
7. Макет комнаты (§7) шириной до 1040px, отступ сверху 56px, за ним кольцо роя (§4.4). Подпись под макетом, 14px `--muted`: `An illustration of a room. In Parley these are your own Claude Code, Codex and GLM sessions, and the decision really waits for you.`

### 5.3 Why Parley (`--surface`)

Eyebrow `Why Parley`. H2 `Stop being the courier between models.`

Абзацы:

> Claude Code and Codex are each good at different things, but each one lives in its own terminal and knows nothing about the other. To get a second opinion you copy text between windows, and keeping track of who does what is your job.
>
> Parley puts them in one room. They read the same task, discuss it, and one lead brings you a single decision. You keep your own subscriptions and the official CLIs: Parley adds no API keys and no extra bill.

Рядом (от 1024px — справа, ниже — под текстом) две карточки сравнения.

Карточка `Without Parley`: пункты с приглушённым маркером «–», текст `--muted`.

- `Copy an answer from one terminal into another`
- `Retell each agent what the others decided`
- `Flip through tabs so you don't miss a permission prompt`

Карточка `In a Parley room`: пункты с маркером-точкой цвета `--sage`, текст `--text`.

- `Write the task once — every agent in the room reads it`
- `Agents write to each other in one feed you can follow`
- `One lead brings one decision: Accept, or Return for rework`

### 5.4 Rooms (`#rooms`, `--bg`)

Eyebrow `Rooms`. H2 `From a task to a decision you accept.`

Две колонки (от 1024px). Слева — нумерованный список из пяти шагов: номер 01–05 шрифтом display цвета `--sage`, заголовок шага H3, текст.

1. `Gather a team.` — `Press ⌘T and add two or more agents: Claude Code, Codex or GLM, each with its own model and, if you like, a role and its own git worktree. Star the lead.`
2. `Give the task once.` — `Write it in the room and it goes to everyone. Type @ to address only some of them.`
3. `Agents discuss.` — `Every member answers with its position. All of them see the whole feed and write to each other through Parley; a sleeping agent wakes up when a message comes for it.`
4. `The lead brings a decision.` — `It collects the positions and proposes one decision. The card waits for you: Accept, or Return for rework with a note.`
5. `The work is handed out.` — `Once you accept, the lead gives out the parts and the agents start. Open any agent's terminal with a click and review the result in Changes: diff, commit, merge.`

Справа — липкий (`position: sticky; top: 96px`) настоящий скриншот в рамке (радиус 28px, `--shadow-lg`):

```html
<picture>
  <source srcset="media/room-decision-dark.webp" media="(prefers-color-scheme: dark)">
  <img src="media/room-decision-light.webp" …>
</picture>
```

`alt`: `A Parley room: four agents discuss refunds and the lead's decision waits with Accept and Return for rework`. Подпись: `A real room in Parley.`

Ниже на всю ширину — H3 `Four modes, from a talk to a plan that runs itself.` и четыре карточки в ряд (две колонки до 1024px, одна до 640px):

- `Free` — `The decision is plain text.`
- `Checklist` — `The decision is a plan with owners, and Parley wakes them in turn.`
- `Verified` — `Every item has acceptance criteria and an independent verifier; you accept the summary.`
- `Autonomous`, тег `New in 0.22` — `After your Go, the host runs each item in an isolated clone, checks it on the exact commit, has a verifier judge the criteria and merges accepted attempts into an integration branch. You accept the result.`

Под карточками строка `--muted`: `Recipes fill in a room for you: Plan & build, Review and Debug are built in, and a project can add its own.`

### 5.5 Watch (`--surface`)

Eyebrow `Demo`. H2 `A minute of Parley.` Lead `Rooms, the island and the built-in browser, recorded in the app.`

Видео в рамке (до 1080px, радиус 28px, `--shadow-lg`, `overflow: hidden`): `<video controls preload="none" playsinline poster="media/parley-demo-poster.webp" width="1280" height="720">` с источником `media/parley-demo.mp4`. Внутри — запасная ссылка на файл.

### 5.6 The island and the assistant (`#island`, всегда чёрная полоса)

Фон `#000`, текст `--on-island`, приглушённый `#a8a095`. В тёмной теме сверху и снизу линия `color-mix(in srgb, #f2ebdd 10%, transparent)`. Eyebrow — терракота `#eea373`.

Eyebrow `The island`. H2 `Answer your agents without switching windows.`

Lead: `The island is a black panel at the top of the screen. On a MacBook with a notch it is exactly the size of the notch until something needs you; then it drops down with a card.`

Две колонки (от 1024px). Слева — макет острова (§8). Справа — список (маркер — маленькая точка роя):

- `Allow, Always or Deny a permission request.`
- `Answer an agent's questions — up to four at once, with options or your own answer.`
- `Approve a plan, see what an agent is doing right now and which subagents it runs.`
- `Open a room whose decision waits for you.`
- `Control+Alt+I walks through everything pending from the keyboard.`
- `Short sounds synthesized on the fly, no sound files. Reduce motion stills it all.`

Тег `New in 0.22` возле H2 не нужен. Он стоит у пунктов 2, 3 и 5 — маленькой пилюлей после текста.

Ниже — две карточки (фон `#141210`, рамка `color-mix(in srgb, #f2ebdd 10%, transparent)`, радиус 28px).

Карточка `The assistant`, H3 `Ask the assistant. It acts only on your click.`

> Press ⌥Space or click the swarm and ask about your agents, works and rooms. The assistant sees every open work, room and session. It prepares cards — a letter, a room, an answer to an agent, a whole plan of new agents — and nothing happens until you confirm. It runs on your own subscription: each question is a short CLI run, not an API call.
>
> With Speak answers on, it talks in a neural voice: Qwen3-TTS, run on your Mac by speech.cpp, with five voices. Its swarm becomes a face whose mouth follows the voice. No text or audio leaves your Mac for the voice.

Мини-макет над текстом: клавиша `⌥ Space`, пузырь вопроса `Who's waiting for me?` и пузырь ответа `Two things: S04 tests asks to run pnpm test:e2e, and the Refunds room has a decision for you.`

Карточка `Telegram`, H3 `Your agents in your pocket.`

> Link your own Telegram bot. Requests that need you arrive as cards with Allow, Deny and Answer buttons; finished turns and letters come as messages; voice messages go to the assistant and are transcribed on your Mac by Whisper. One bot, one owner: strangers get no reply.

### 5.7 Features (`#features`, `--bg`)

Eyebrow `Features`. H2 `Everything around the room.`

Bento-сетка. От 1024px — три колонки:

```
"f1 f1 f2"
"f3 f4 f5"
"f6 f7 f8"
"f9 f9 f9"
```

От 640px — две колонки (f1 и f9 на обе), ниже — одна. В каждой карточке сверху «образец» — маленький кусок интерфейса в HTML и CSS в стиле окна, без иконок и картинок. Под образцом — H3 и текст.

**f1 `Any mix of agents`**
> Claude Code, Codex and GLM work side by side, each with its own model, role and, if you like, its own git worktree. Add any Anthropic-compatible provider — Kimi, MiniMax, Qwen, DeepSeek, OpenRouter or your own address — or a second Claude Code account with its own sign-in and limits.

Образец: ряд пилюль `Claude Code` `Codex` `GLM` `Kimi` `MiniMax` `Qwen` `DeepSeek` `OpenRouter` `Claude Code 2` `+ your own`; у первых трёх слева точка цвета провайдера (§7.1).

**f2 `A browser your agents can drive`**
> Agents open pages, click, type, read the page and take screenshots — only in the browser panels of their own chat and rooms; your own tabs stay closed to them. Secrets in addresses, logs and form fields are masked.

Образец: мини-окно браузера с пилюлей адреса `localhost:5173`. Внутри — блок, обведённый янтарной пунктирной рамкой (`#e0a43a`), и плашка `S02 backend · Stop`.

**f3 `Changes: diff, commit, merge`**
> Give an agent its own git worktree, then review its diff, commit and merge without leaving the window. With git 2.38 or newer you see conflicts before you merge.

Образец: строки-пилюли файлов `refund.ts` `+42` (`--sage-text`) `−7` (`--accent-text`) и `refund.test.ts` `+88`, под ними главная малая кнопка `Merge into main`.

**f4 `Agents say why they wait`**
> A session that needs you shows the reason: an approval, a question, a usage limit, a sign-in. The room hears about it too, and after a usage limit resets Parley brings the session back.

Образец: две строки сессий, как в сайдбаре: `S02 backend` со словом `needs you · approval` на фоне `--accent-soft`; `S03 review` со словом `usage limit until 19:27`.

**f5 `Your team's rules`**
> Write the rules once in PARLEY.md and every agent Parley launches in the project gets them. Built-in roles give each agent its job, a lead can start new sessions itself, and plans come with a backlog, memory and search.

Образец: чип файла `PARLEY.md` (моноширинный) и пилюли ролей `Planner` `Critic` `Executor` `Reviewer` `Debugger`.

**f6 `Chat or terminal`**
> Every session is the real CLI in a real terminal. Chat view shows the same session as a conversation, with Reply quotes, code Copy and links that open in Parley's browser.

Образец: пузырь ответа модели с кодом `RefundTooLarge` и строкой действий `Reply · Copy`.

**f7 `Token usage in every room`**
> The room header shows how many tokens its members used, with a breakdown by provider and by session. What a CLI doesn't report stays "?" instead of turning into zero.

Образец: чип `↑1.2M ↓84k` (моноширинный) и три строки разбивки: `Claude Code ↑820k ↓51k`, `Codex ↑310k ↓24k`, `GLM ↑70k ↓9k`.

**f8 `⌘J and your voice`**
> The command palette finds any workspace, session or action. Dictate messages and rework notes: speech is transcribed on your Mac by Whisper.

Образец: клавиши `⌘` `J` и пилюля диктовки — точка `--accent` и `Dictating 0:04`.

**f9 `Fast with long works`** (полоса на всю ширину: текст слева, два числа справа)
> Works live in one SQLite database, and a letter reaches the window as about 1.5 KB instead of a full refresh. On a test stand, 60 letters into a room of three caused 0 full refreshes instead of 60, and sent 88 KB to the window instead of 11 MB.

Числа шрифтом display: `0` с подписью `full refreshes, was 60` и `88 KB` с подписью `to the window, was 11 MB`.

### 5.8 Principles (`#principles`, `--surface`)

Eyebrow `Principles`. H2 `You stay in charge.`

Пять строк. Слева номер `01`–`05` шрифтом display цвета `--accent-display`, справа H3 и текст. От 1024px — две колонки: H2 липкий слева, строки справа.

1. `Nothing starts without you.` — `No YOLO flags. No work before you accept the decision. Parley never closes a session or puts it to sleep on its own, and quitting asks first.`
2. `Your CLIs, your login.` — `Parley starts the unmodified claude and codex from your PATH, signed in as you. It never reads or stores their credentials, makes no requests to the Anthropic or OpenAI APIs, and adds no API keys and no extra bill.`
3. `Local only.` — `The window and parley-host talk over a unix socket with its own handshake token; nothing is reachable from the network. No server, no telemetry. Parley's own requests are a once-a-day release check on GitHub, which you can turn off, and, for GLM, a quota query to Z.ai.`
4. `Voice stays on your Mac.` — `Dictation runs on Whisper and the assistant's voice on Qwen3-TTS, both on your Mac: no text or audio leaves it for them.`
5. `Honest release notes.` — `Every release says what is not proven yet.`

Под пятой строкой — цитата крупным шрифтом display (`clamp(1.375rem, 1rem + 1.4vw, 2rem)`), с кавычками-ёлочками в цвете `--accent`:

- Без JS: `“Autonomous rooms passed their tests with stub agents; the pilot on real agents was stopped and a full live cycle has not been run.”` с подписью `— from the Parley 0.22.0 release notes`, ссылка на `https://github.com/Kalmbik61/Parley/releases/tag/v0.22.0`.
- С JS: первый пункт «What is not proven yet» самого свежего релиза, где этот раздел есть. Подпись `— from the Parley X.Y.Z release notes` ведёт на страницу этого релиза (§6.4).

### 5.9 How it works (`--bg`)

Eyebrow `How it works`. H2 `Official CLIs in a local app.`

Схема в HTML и CSS: три карточки, соединённые пунктирными линиями с подписями. От 1024px карточки стоят в ряд, ниже — колонкой, связи вертикальные.

- `Parley.app` — `The window`.
- Связь: `unix socket · handshake token`.
- `parley-host` — `Runs every agent's terminal and outlives the window`, ниже моноширинным `~/.parley/parley.db`.
- Связь: `PTY + MCP`.
- `Your CLIs`: пилюли `claude` `codex` `GLM via claude`, затем пилюли со знаками `Kimi` `MiniMax` `Qwen` `DeepSeek` `OpenRouter` и `+ your own`. Это по слову человека: «тут не только они, а разные вендоры».

Под схемой — четыре пункта 2×2 (от 640px):

- `One host for every terminal.` — `parley-host runs the agents' terminals and outlives the window: close the window and they keep working.`
- `Agents talk through Parley.` — `Every agent gets Parley's MCP server: it reads the shared workspace map, sends and reads messages, and proposes decisions.`
- `Mail waits for the turn.` — `The host types a short pointer into an agent's terminal only after it finishes its turn, and only urgent mail wakes an idle agent at once.`
- `One database.` — `Works, letters and rooms live in one SQLite database on your Mac.`

### 5.10 Releases (`#releases`, `--surface`)

Eyebrow `Releases`. H2 `Shipping in the open.` Lead: `Release notes straight from GitHub: what was added, what changed and what is not proven yet.`

- От 1024px: слева (7/12) карточка последнего релиза, справа (5/12) три предыдущих одна под другой. Ниже — одна колонка.
- Каждая карточка — одна ссылка `<a>` на страницу своего релиза (`html_url`). Внутри других ссылок нет.
- Под сеткой две ссылки: `All releases on GitHub →` (страница релизов) и `Changelog`.
- Состояния: загрузка — четыре карточки-заглушки (`aria-busy="true"` на списке); ошибка или нет данных — одна карточка `The release list didn't load. The notes are on GitHub.` с вторичной кнопкой `Open releases on GitHub`. Без JS — та же карточка: она и есть разметка по умолчанию, JS её заменяет.

Содержимое карточек — §6.4.

### 5.11 Install (`#install`, `--bg`)

Eyebrow `Install`. H2 `Up and running in three steps.`

Три карточки-шага в ряд (одна колонка до 1024px), номер шрифтом display:

1. `Download` — `Pick the build for your Mac, about 200 MB. Open the .dmg and drag Parley to Applications.` Две кнопки: главная `Apple Silicon` (ссылка на arm64 dmg) и вторичная `Intel` (x64 dmg). Под ними мелким: `Not sure? Apple menu → About This Mac shows "Chip" on Apple Silicon and "Processor" on Intel.`
2. `Allow the first launch` — `Parley is not signed with an Apple Developer ID yet, so macOS blocks the first launch. Run this once in Terminal:` Тёмный блок кода (фон `#201e1d`, текст `#f2ebdd` в обеих темах, радиус 16px, моноширинный) `xattr -dr com.apple.quarantine /Applications/Parley.app` и кнопка `Copy`. После копирования кнопка на 2 с меняется на `Copied`, рядом `aria-live="polite"`. Ниже: `Or open System Settings → Privacy & Security and click Open Anyway.`
3. `Start` — три строки с клавишами: `⌘N` `A new workspace: choose a project folder.`, `⌘T` `A new session, or a room of two or more agents.`, затем `Write the task in the room and wait for the lead's decision.`

Ниже карточка требований, H3 `What you need`:

- `macOS 13 (Ventura) or later, on Apple Silicon or Intel.`
- `At least one agent CLI, installed and signed in: Claude Code or Codex. GLM runs through Claude Code with a GLM Coding Plan and a Z.ai API key.`
- `git in your PATH.`
- `Node.js is not needed: the app carries its own.`

Последняя строка `--muted`: `Parley checks GitHub once a day and shows a toast when a new release is out. It does not update itself.`

### 5.12 Финальный призыв (`--surface`)

Карточка на всю ширину контейнера: фон `color-mix(in srgb, var(--accent) 12%, var(--card))`, радиус 28px, по центру. Знак Parley (inline SVG `docs/media/brand/parley-icon.svg`, 72px). H2 `Put your agents in one room.` Строка `Free and open source under the MIT License.` Кнопки: `Download for Mac` (главная, `#install`) и `Star on GitHub` (вторичная, репозиторий).

### 5.13 Подвал (`--bg`, линия сверху `--divider`)

- Слева знак Parley 28px и `Parley`, под ними `© 2026 · MIT License`; год ставит JS, в разметке стоит 2026.
- Ссылки: `GitHub` `Releases` `Changelog` `License` `Notice`.
- Строка мелким `--muted`: `This page sets no cookies, has no analytics and loads nothing from other sites. It was planned and built by agents working in Parley.`
- Строка мелким `--muted`: `Claude, Codex, GLM, DeepSeek, Kimi, MiniMax, OpenRouter and Qwen names and logos are trademarks of their owners. Parley is not affiliated with or endorsed by them.`

## 6. Релизы

### 6.1 Снимок

Workflow публикации (§10) перед загрузкой сайта пишет `site/releases.json` — массив до 8 опубликованных релизов, новые первыми:

```
gh api "repos/$GITHUB_REPOSITORY/releases?per_page=8" \
  --jq '[.[] | select((.draft or .prerelease) | not) | {tag_name, name, html_url, published_at, body}]'
```

Черновики отсекаются ещё в `jq`: токену с `contents: read` они видны, и без фильтра заметки неопубликованного релиза ушли бы на публичный сайт. `site/releases.json` в git не коммитится (`.gitignore`). Для локального просмотра его кладут вручную из фикстуры (§11, T3).

### 6.2 Загрузка в браузере

`main.js` делает `fetch('releases.json')` и разбирает ответ функциями `releases.js`. Не ответ 200, неверный JSON или пустой список — состояние ошибки (§5.10). Запросов к `api.github.com` из браузера нет. `localStorage` не нужен: снимок лежит на том же адресе, кэшем управляет GitHub Pages.

### 6.3 `site/js/releases.js` — чистые функции

Экспорт:

- `parseReleaseNotes(body)` → `{ summary, added, changed, fixed, notProven }`. `summary` — строка; `added`, `changed`, `fixed` — массивы `{ title, text }`; `notProven` — массив строк.
- `toReleaseCard(release)` → `{ tag, version, name, url, date, summary, highlights, counts, notProven }`. Здесь `version` — `tag_name` без ведущей `v`; `date` — `published_at` как есть (ISO); `highlights` — первые 4 элемента `added`; `counts` — `{ added, changed, fixed }`, длины массивов.
- `pickReleases(list, limit = 4)` → без `draft` и `prerelease`, по `published_at` от новых к старым, первые `limit`.
- `firstSentence(text, max)` → до первой точки, за которой идёт пробел или конец строки. Длиннее `max` — обрезать по последнему пробелу до `max` и добавить `…`.
- `stripInline(markdown)` → простой текст: `[текст](url)` → `текст`, без `**`, `__` и обратных кавычек.
- `formatDate(iso)` → `Oct 28, 2026` через `Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })`.

Правила разбора:

1. `body ?? ''`, `\r\n` → `\n`.
2. `summary` — первый абзац до первого заголовка (`/^#{1,6}\s/`): непустые строки до первой пустой, через пробел, затем `stripInline`.
3. Заголовок раздела — `/^#{2,4}\s+(.+?)\s*$/`. Название в нижнем регистре: `added`, `changed`, `fixed` и `what is not proven yet` → `notProven`. Остальные разделы (`updating`, `known issues` и любые новые) пропускаются.
4. Пункт — строка `/^[-*]\s+/` без отступа. Строки с отступом, которые не начинают вложенный пункт, дописываются к текущему пункту через пробел. Вложенные пункты (`/^\s{2,}[-*]\s/`) пропускаются.
5. Пункт → `{ title, text }`. Сначала с конца срезаются ссылки на PR: `/\s*\((?:\[#\d+\]\([^)]*\)(?:,\s*)?)+\)\s*$/`. Пункт вида `**Заголовок.** Остальное`: `title` — заголовок без `**` и без точки или двоеточия в конце, `text` — `stripInline` остального. Иначе `title` — `firstSentence(stripInline(пункт), 110)`, `text` — пустая строка.
6. `notProven` — `stripInline` каждого пункта целиком, без обрезки.

Ожидаемое на настоящих заметках — значения сверены с разделами `CHANGELOG.md`, из которых workflow Release собирает тела релизов:

| Релиз | summary начинается с | added | changed | fixed | notProven |
|---|---|---|---|---|---|
| v0.24.0 | `The assistant's voice can use the larger Qwen3-TTS 1.7B model` | 2 | 0 | 1 | 1: `How fast the 1.7B voice speaks on a real machine has not been measured.` |
| v0.23.0 | `The assistant gets hands:` | 6 | 2 | 5 | 1 |
| v0.22.0 | `The largest release so far.` | 12 | 9 | 2 | 2 |
| v0.21.0 | `A second Claude Code account of yours as a provider` | 4 | 5 | 0 | 0 |

У v0.24.0 `added[0]` — `{ title: 'Qwen3-TTS 1.7B voice', text: 'Settings → Assistant → Voice lists the 0.6B and 1.7B models, each with its own Download, Cancel, Delete and progress. The assistant speaks with the largest downloaded model; nothing downloads on its own.' }`. `added[1].title` начинается с `Sleeping sessions (no process; Resume wakes them) show` и, если длиннее 110 символов, кончается на `…`.

Если разбор настоящих заметок расходится с таблицей, исполнитель не подгоняет таблицу под код. Он пересчитывает разделы вручную и пишет ведущему, где ошибка.

### 6.4 Отрисовка

Весь текст из релизов вставляется через `textContent`, без `innerHTML`.

- **Пилюля hero:** `New in {version} — {firstSentence(summary, 72)}`, ссылка на `url` последнего релиза.
- **Версия в hero:** `Latest v{version} · ` перед `Free · MIT license · macOS 13 or later`, версия — ссылка на релиз.
- **Карточка последнего релиза:**
  - мета: тег `Latest` (вариант `question`), `v0.24.0` моноширинным, `<time datetime="…">Oct 28, 2026</time>`;
  - H3 — `name`;
  - описание — `summary` целиком;
  - список `highlights`: жирный `title` и `firstSentence(text, 140)`, если `text` не пуст;
  - строка счётчиков без нулевых: `2 added · 1 fixed`;
  - если есть `notProven[0]` — блок на фоне `color-mix(in srgb, var(--text) 5%, transparent)`: подпись `Not proven yet` и текст;
  - внизу `Read the release notes →`.
- **Три предыдущих:** мета (версия и дата), H3 — `name`, `firstSentence(summary, 160)` (не больше трёх строк, `line-clamp`), счётчики и `→`.
- **Цитата в Principles:** первый релиз из списка с непустым `notProven` (§5.8).

## 7. Живая комната (hero)

### 7.1 Макет

Окно: радиус 28px, фон `--window`, `--shadow-lg`, рамка 1px `--divider`, `overflow: hidden`. Шрифт внутри 14px (13px до 640px).

- **Полоса заголовка** 44px: три точки 11px цвета `--neutral-400` (не светофор), по центру `Refunds — Parley` 13px `--muted`. Справа кнопка `Replay` — видна только в конце сценария.
- **Сайдбар** 232px, фон `--surface`. Виден от 900px.
  - Проект: точка `--accent` и `shop` шрифтом display 15px.
  - Карточка работы: фон `--card`, `Payments`, мета `shop · 4 sessions · main`.
  - Строка комнаты `# Refunds`. Пока решение ждёт, у неё слово `decision` на фоне `--accent-soft`.
  - Строки сессий `S01 architect ★`, `S02 backend`, `S03 review`, `S04 tests` со словом состояния. Состояния те же, что у чипов участников.
- **Шапка комнаты:** `Refunds` шрифтом display 26px. Под ним 13px `--muted`: `Created by you · 4 agents · lead S01 · Payments`.
- **Лента участников** — горизонтальная прокрутка, четыре чипа по 210px.
  - Первая строка: точка состояния, имя (вес 600), `★` у ведущего, слово состояния.
  - Вторая строка, `--muted`: провайдер.
  - Агенты: `S01 architect` (лидер, Claude Code), `S02 backend` (Claude Code), `S03 review` (Codex), `S04 tests` (GLM).
  - Состояния: `idle` — серая точка `--neutral-400`; `working` — вращающееся кольцо `--muted`; `needs you` — фон `--accent-soft`; `done` — точка `--sage`.
- **Аватар в ленте** — круг 22px цвета провайдера с номером агента белым 11px. Цвета провайдеров: Claude Code — `#c67139`, Codex — `#474238`, GLM — `#7a8a5e`. У человека — круг `--sage-soft` с буквой `Y` цвета `--sage-text`.
- **Поле ввода внизу:** подпись `To everyone`, поле-пилюля с плейсхолдером `Write to everyone · type @ to mention an agent` и кнопка `Send`. И поле, и кнопка неактивны, их «нажимает» сценарий.

### 7.2 Сценарий

Старт — когда окно видно хотя бы на 35% (`IntersectionObserver`), один раз. Время — от старта.

| t | Что происходит |
|---|---|
| 0.0 | Поле ввода печатает по 28 мс на символ: `Add partial refunds to refund.ts. Agree on the rules first, then split the work.` |
| ≈2.8 | `Send` подсвечивается, в ленте — сообщение `You → all` с этим текстом. Все четыре чипа — `working`. |
| 4.2 | Под лентой 0.8 с: `S01 architect is writing…` и три точки. |
| 5.0 | `S01 architect ★ → all`, тег `question`: `Should partial refunds be capped by the captured amount? @S02 backend, what does refund.ts do today?` |
| 6.6 | `S02 backend → all`, тег `note`: `Today it only checks the order total. I'd reject anything above the captured amount with RefundTooLarge and keep the capture currency.` S02 — `idle`. |
| 8.0 | `S03 review → all`, тег `note`: `Agreed. Add a test for multi-currency captures — that's where it broke last time.` S03 — `idle`. |
| 9.4 | `S04 tests → all`, тег `note`: `I'll cover it end-to-end: capture in EUR, refund in two parts, then a third one that must fail.` S04 — `idle`. |
| 11.0 | Карточка решения (§7.3). S01 — `idle`, у строки комнаты в сайдбаре — `decision`. Кнопка `Accept` дважды пульсирует кольцом, потом замирает. |

Дальше сценарий ждёт посетителя: решение ждёт человека — в этом и смысл.

Перед каждым сообщением агента, кроме первого, 0.6 с видна строка `{имя} is writing…`. `@S02 backend` и прочие упоминания — чипы упоминания (§4.3). Новое сообщение проявляется за 300 мс со сдвигом 8px. Лента прокручивается к нему только внутри окна, страница не прыгает.

### 7.3 Карточка решения

Рамка 1.5px `--accent`, фон `color-mix(in srgb, var(--accent) 9%, transparent)`, радиус 16px. Шапка: аватар S01, `S01 architect`, тег `question` с текстом `decision · waiting for you`, `now`.

Текст: `Refunds above the captured amount fail with RefundTooLarge; partial refunds stay in the capture currency. Split: @S02 backend — refund.ts and a unit test, @S03 review — the diff, @S04 tests — e2e.`

Кнопки `Accept` (главная) и `Return for rework` (вторичная).

**Accept**

1. Кнопки сменяются строкой `--sage-text`: `✓ You accepted this decision`. `decision` в сайдбаре исчезает.
2. Через 0.6 с — сообщение `S01 architect ★ → all`, тег `decision`: `@S02 backend — refund.ts and a unit test. @S03 review — the diff. @S04 tests — e2e.` S02 и S04 — `working`.
3. Через 3.0 с — `S02 backend → all`, тег `note`: `refund.ts is done: RefundTooLarge above the captured amount, unit test green. @S03 review, the diff is yours.` S02 — `done`, S03 — `working`.
4. Появляется `Replay`.

**Return for rework**

1. Кнопки сменяются полем (`textarea`, радиус 14px, плейсхолдер `What should the lead change?`) и кнопками `Send to lead` (главная) и `Cancel`. В поле печатается `Also cap the sum of all partial refunds.` — посетитель может стереть и написать своё.
2. `Cancel` возвращает кнопки.
3. `Send to lead`:
   - карточка сменяется строкой `--muted`: `↩ Returned for rework: «{текст поля}»`;
   - S01 — `working`, 1.2 с — `S01 architect is writing…`;
   - затем новая карточка решения с текстом `Version 2, with your note. Refunds above the captured amount fail with RefundTooLarge; partial refunds stay in the capture currency. Split: @S02 backend — refund.ts and a unit test, @S03 review — the diff, @S04 tests — e2e.` Обе кнопки снова работают.

**Replay** сбрасывает всё к пустой ленте и запускает сценарий сначала.

### 7.4 Без JS и с reduced motion

- Разметка по умолчанию — состояние на t = 11.0: сообщение человека, четыре сообщения агентов и карточка решения, у которой обе кнопки `disabled`. Без JS это читаемая статичная картинка.
- С JS при `prefers-reduced-motion: reduce` сценарий сразу показывает состояние t = 11.0, без печати и задержек, и включает кнопки. `Accept` и `Return for rework` работают, все шаги показываются сразу. Печать в поле заметки тоже мгновенная.

## 8. Остров

Макет — верх экрана MacBook: прямоугольник `#0b0a09` с радиусом 20px сверху, рамка 1px `color-mix(in srgb, #f2ebdd 12%, transparent)`, высота около 360px. По центру сверху — вырез: чёрная плашка 180×30px со скруглёнными нижними углами.

- **Капсула** (свёрнутый остров) обнимает вырез: чёрная, шире выреза на 56px с каждой стороны. Слева рой — четыре точки 6px (`#A9B78D`, `#C2A16D`, `#CF7847`, `#A9B78D`) вращаются вокруг центра, оборот за 4 с. Справа счётчик `2` (`#f2ebdd`, 13px, вес 600).
- **Раскрытый остров** — чёрная карточка шириной `min(520px, 100%)` под вырезом, радиус 28px снизу и 18px сверху, отступы 18px 20px. Раскрывается из капсулы: ширина и высота меняются с лёгким перелётом, `cubic-bezier(.34,1.56,.64,1)`, 450ms. Сворачивается без перелёта.

Четыре состояния по кругу. Каждое показано 4.5 с, между ними капсула на 0.6 с.

1. **Разрешение.** Шапка `S04 tests` (600) `· shop` (`#a8a095`) и пилюля `CLAUDE CODE` (10px, рамка `#CF7847`, цвет `#eea373`). Справа `1 of 2`. Моноширинный блок (фон `#141210`, радиус 12px): `Bash` цветом `#eea373` и `pnpm test:e2e refunds`. Кнопки: `Allow` — фон `#d67f48`, текст `#0e0d0c`; `Always` и `Deny` — рамка `color-mix(in srgb, #f2ebdd 30%, transparent)`.
2. **Вопрос.** Шапка `S02 backend · shop`, справа `Question 1 of 2`. Текст `Which currency should the e2e capture use?` Варианты пилюлями: `EUR — the store's default` (выбран, рамка `#d67f48`), `USD`, `Other`. Кнопки `Back` и `Next`.
3. **Комната ждёт.** Шапка `# Refunds · shop`. Текст `S01 architect brings a decision. It waits for you.` Кнопка `Open room`.
4. **Готово.** Шапка `S02 backend · shop` и галочка `#9aad7b`. Текст `Done: refund.ts and a unit test, all green.` Справа `now`.

Под макетом — четыре точки-кнопки переключения (`aria-label`: `Show a permission request`, `Show a question`, `Show a room waiting for you`, `Show a finished turn`). У текущей — `aria-current="true"`. Наведение или фокус внутри макета ставят цикл на паузу. «Кнопки» внутри карточек острова — `<span>` с видом кнопки, а не `<button>`: они ничего не делают, состояния переключают только точки.

Без JS и с reduced motion видно состояние 1, раскрытое. С reduced motion цикл не идёт, точки переключают без анимации.

## 9. Медиа и шрифты

Источники — в git этой ветки, кроме обложки: `docs/promo/` есть только в основной папке проекта и не закоммичен. Команды запускаются из корня worktree, их же записать в `site/README.md`.

```bash
mkdir -p site/fonts site/media
# Шрифты: woff2 из тех же файлов, что у окна, вместе с лицензиями OFL
python3 -m fontTools.ttLib.woff2 compress -o site/fonts/Figtree-Variable.woff2 packages/desktop/src/renderer/assets/fonts/Figtree-Variable.ttf
python3 -m fontTools.ttLib.woff2 compress -o site/fonts/Caprasimo.woff2 packages/desktop/src/renderer/assets/fonts/Caprasimo.ttf
cp packages/desktop/src/renderer/assets/fonts/{Figtree,Caprasimo}-OFL.txt site/fonts/
# Скриншот комнаты
cwebp -q 82 -resize 1400 0 docs/media/room-decision-light.png -o site/media/room-decision-light.webp
cwebp -q 82 -resize 1400 0 docs/media/room-decision-dark.png -o site/media/room-decision-dark.webp
# Демо: 720p, H.264, moov в начале файла
ffmpeg -y -i docs/media/parley-demo.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 96k site/media/parley-demo.mp4
cwebp -q 80 -resize 1280 0 docs/media/parley-demo-poster.png -o site/media/parley-demo-poster.webp
# Картинка для соцсетей: обложка без строки с версией v0.12 внизу
ffmpeg -y -i /Users/kalmbik61/Desktop/MY/my_harnas/docs/promo/media/00-cover.png -vf "crop=1386:726:267:100,scale=1200:630" -q:v 3 site/media/og-image.jpg
# Иконки
cp docs/media/brand/parley-icon.svg site/favicon.svg
sips -z 180 180 packages/desktop/build/icon.png --out site/apple-touch-icon.png
sips -z 32 32 packages/desktop/build/icon.png --out site/favicon-32.png
```

Результат проверить глазами. В `og-image.jpg` логотип, слоган и пилюли целы, строки `v0.12 …` нет, поля сверху и снизу примерно равны. Если кадр съехал, подобрать смещение и обновить команду в README.

Бюджеты:

- woff2 — оба вместе до 90 KB;
- каждая webp — до 200 KB;
- `og-image.jpg` — до 150 KB;
- видео — до 4.5 MB;
- `index.html` — до 70 KB, `styles.css` — до 45 KB, весь JS — до 35 KB (без сжатия).

## 10. Публикация

### 10.1 `.github/workflows/pages.yml`

Стиль — как у `ci.yml` и `release.yml`: русские комментарии в шапке, действия по полному SHA с версией в комментарии, токен только в `env` шага.

```yaml
name: Pages

on:
  push:
    branches: [master]
    paths: ['site/**', 'scripts/site/**', '.github/workflows/pages.yml']
  pull_request:
    paths: ['site/**', 'scripts/site/**', '.github/workflows/pages.yml']
  # Новый релиз. Release публикует его токеном репозитория, а событие release от такого токена других workflow не
  # запускает; workflow_run по завершении Release — запускает.
  workflow_run:
    workflows: [Release]
    types: [completed]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages-${{ github.ref }}
  cancel-in-progress: false

jobs:
  test:
    name: Test the site scripts
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false

      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22

      - name: Test the release notes parser
        run: node --test scripts/site/releases.test.mjs

  deploy:
    name: Deploy to GitHub Pages
    needs: test
    if: github.ref == 'refs/heads/master' && github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Checkout
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false

      - name: Snapshot the release list
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: >-
          gh api "repos/$GITHUB_REPOSITORY/releases?per_page=8"
          --jq '[.[] | select((.draft or .prerelease) | not) | {tag_name, name, html_url, published_at, body}]'
          > site/releases.json

      - name: Upload the site
        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: site

      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1
```

SHA сверены `git ls-remote --tags` на 2026-10-28. Это лёгкие теги, строк `^{}` у них нет.

### 10.2 Страж workflow

`packages/desktop/src/release-workflows.test.ts`:

- В `ALLOWED_ACTIONS` добавить `'actions/upload-pages-artifact': { sha: 'fc324d3547104276b827a68afc52ff2a11cc49c9', version: 'v5.0.0' }` и `'actions/deploy-pages': { sha: '368f82528645a54fb793d4d04e342629a3f51346', version: 'v5.0.1' }`.
- Общие правила (`it.each(names)`) подхватят `pages.yml` сами. Файл обязан их пройти: есть `run`, нет `${{` в `run`, все `uses` из списка, у каждого checkout `persist-credentials: false`, `secrets.` только в строке `          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, на верхнем уровне `permissions:` с одним `contents: read`.
- Новый `describe('pages.yml')` в стиле файла (регулярные выражения по тексту, русские заголовки `it`):
  - триггеры: push в master с `site/**`, pull_request, `workflow_run` на `[Release]`, workflow_dispatch;
  - задача `deploy` — `needs: test`, условие с `refs/heads/master` и `pull_request`, права `pages: write` и `id-token: write`, окружение `github-pages`, путь артефакта `site`;
  - снимок релизов отсекает черновики (`select((.draft or .prerelease) | not)`);
  - задача `test` запускает `node --test scripts/site/releases.test.mjs`.

### 10.3 Что делает человек

1. Слить ветку в master (PR).
2. Один раз: Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Запустить Actions → Pages → Run workflow или дождаться следующего push в `site/`. Сайт — `https://kalmbik61.github.io/Parley/`.
4. По желанию — адрес сайта в поле Website репозитория и ссылка в README.

## 11. Задачи

Порядок T1 → T4. Каждую ведущий принимает до выдачи следующей. Исполнитель работает только в worktree, ничего не коммитит и не пушит, отчёт — `report` с путями файлов и доказательствами по каждому критерию.

Локальный просмотр: `python3 -m http.server 8137 --directory site`, страница — `http://localhost:8137/`. Открывать в браузере Parley (`browser_open`), смотреть `browser_screenshot`, ошибки — `browser_console`. Тёмная тема для проверки: `document.documentElement.dataset.theme = 'dark'` через `browser_evaluate`.

### T1. Каркас, облик, медиа

**Объём:** `site/index.html` со всеми секциями §5 и всем текстом (релизы — в состоянии по умолчанию §5.10, комната — статичная разметка §7.4, остров — статичное состояние 1 §8); `site/styles.css` (§4, все секции, обе темы, адаптив); шрифты, медиа и иконки (§9); `<head>` (§5.0); `site/README.md`; строка `site/releases.json` в `.gitignore` с комментарием в стиле файла. JS — только `main.js` с классом `js` на `<html>`, линией шапки, появлением при прокрутке и годом в подвале.

**Приёмка:**

- Скриншоты 1440×900 и 375×812, светлая и тёмная тема, полная страница. Все секции на месте, текст совпадает с §5.
- На 375px нет горизонтальной прокрутки: `document.documentElement.scrollWidth <= innerWidth`.
- Шрифты Caprasimo и Figtree грузятся с локального адреса: `document.fonts.check('16px Caprasimo')` — `true`. Сетевых запросов к другим хостам нет (`browser_network`).
- Контраст текста по §4.1. Цифры — для `--text` и `--muted` на `--bg` и `--surface` в обеих темах.
- Бюджеты §9 соблюдены, размеры файлов в отчёте.
- Без JS (проверка — открыть с отключённым модулем или посмотреть разметку) всё содержимое видно.
- В консоли нет ошибок.

### T2. Релизы

**Объём:** `site/js/releases.js` (§6.3); отрисовка в `main.js` (§6.2, §6.4): пилюля и версия в hero, карточки, цитата в Principles, состояния загрузки и ошибки; `scripts/site/fixtures/releases.json`; `scripts/site/releases.test.mjs`.

- Фикстура: v0.24.0, v0.23.0, v0.22.0 и v0.21.0 с полями `tag_name`, `name` (`Parley X.Y.Z`), `html_url` (`https://github.com/Kalmbik61/Parley/releases/tag/vX.Y.Z`), `published_at` (`2026-10-28T16:58:26Z`, `2026-10-28T12:22:07Z`, `2026-10-27T21:55:02Z`, `2026-10-22T13:16:21Z`) и `body` — текстом раздела `## X.Y.Z` из `CHANGELOG.md`, без самой строки заголовка.
- Тесты:
  - таблица §6.3 по фикстуре;
  - `added[0]` у v0.24.0;
  - пустое и `null`-тело;
  - тело с `\r\n`;
  - тело без разделов;
  - вложенные пункты не считаются;
  - ссылки на PR срезаются;
  - `pickReleases` убирает `draft` и `prerelease` и сортирует по дате;
  - `firstSentence` обрезает по слову и ставит `…`;
  - `formatDate` даёт `Oct 28, 2026`.

**Приёмка:**

- `node --test scripts/site/releases.test.mjs` — зелёный, вывод в отчёте.
- С `cp scripts/site/fixtures/releases.json site/releases.json`: скриншоты блока релизов 1440 и 375, пилюля hero `New in 0.24.0 — …`, цитата v0.24.0 в Principles. Каждая карточка — ссылка на свой `html_url`, «All releases» ведёт на страницу релизов.
- Без `site/releases.json` (404) — состояние ошибки §5.10 и пилюля по умолчанию. Скриншот.
- `innerHTML` для текста релизов не используется.

### T3. Живая комната и остров

**Объём:** `site/js/room-demo.js` (§7), `site/js/island.js` (§8), кнопка `Copy` в установке (§5.11), подключение из `main.js`.

**Приёмка:**

- Сценарий §7.2 идёт после прокрутки к окну. Скриншоты: середина сценария, ожидающее решение, после `Accept` (с `Replay`), после `Return for rework` → `Send to lead` (карточка `Version 2…`).
- `Replay` повторяет сценарий. Повторный `Accept` не дублирует сообщения.
- Остров проходит четыре состояния. Наведение ставит его на паузу, точки переключают. Скриншот каждого состояния.
- Reduced motion (проверить через эмуляцию `prefers-reduced-motion` в Chrome DevTools или временный вызов кода с флагом): комната сразу в состоянии t = 11.0, кнопки работают, остров не крутится, кольцо роя не вращается.
- `Copy` кладёт в буфер ровно `xattr -dr com.apple.quarantine /Applications/Parley.app` и показывает `Copied`.
- С клавиатуры (Tab) доступны `Accept`, `Return for rework`, поле заметки, `Send to lead`, `Replay`, точки острова, `Copy`. Фокус виден.
- Страница не прыгает, пока лента комнаты прокручивается. В консоли нет ошибок.

### T4. Публикация

**Объём:** `.github/workflows/pages.yml` (§10.1), правка стража (§10.2), раздел о публикации в `site/README.md` (§10.3).

**Приёмка:**

- Перед прогоном стража: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --prefer-offline` в worktree. Затем `pnpm --filter @parley/desktop exec vitest run src/release-workflows.test.ts` — зелёный, число тестов до и после правки в отчёте.
- YAML разбирается: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/pages.yml'))"`. Если PyYAML нет — `ruby -ryaml -e 'YAML.load_file(".github/workflows/pages.yml")'`.
- Команда снимка из шага workflow, выполненная локально (`curl` к API с тем же фильтром `jq` вместо `gh`), даёт массив без черновиков. Если API отвечает лимитом — так и написать, это не провал.
- `pnpm lint` не трогает `site/` и `scripts/site/`. Убедиться, что новых ошибок нет.

## 12. Общая приёмка (ведущий)

- Просмотр в браузере Parley: 1440 и 375, светлая и тёмная, reduced motion, без снимка релизов.
- Lighthouse (Chrome DevTools, мобильный профиль): Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95.
- Нет запросов на другие хосты. Нет cookies. Нет `localStorage`.
- Текст страницы сверен с §5; каждое утверждение о продукте ведёт к README, CHANGELOG или заметкам релиза.
- Страж workflow зелёный; `node --test` зелёный.
