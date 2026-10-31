# Мобильное приложение Parley: полный удалённый доступ с телефона — ресерч

Дата: 2026-10-28. Рой sw-01 (королева s-77; 9 дронов, 5 верификаторов). Только чтение.
Базы: Parley `f7978af8`; coucou `47d1c2da` (Louis-CFM/coucou, 2026-10-23); Orca `7b3fb541` / `dd0c4cf3` (stablyai/orca, 2026-10-28).
Сокращения ссылок: `C/` = https://github.com/Louis-CFM/coucou/blob/47d1c2da12bf1dce8fb28b825757d497c1e1d88d/ ,
`O/` = https://github.com/stablyai/orca/blob/dd0c4cf35e754ffaeebe59b9979347d22988b2cb/ .
Метки: [V] — подтверждено верификатором, [D] — только дрон (не перепроверено), [H] — гипотеза/вывод.


## 0. Коротко

1. **Orca не ходит по SSH.** SSH у Orca — это десктоп как SSH-клиент к удалённым dev-серверам (`ssh2`/системный OpenSSH). Телефон говорит с десктопом по WebSocket: напрямую (LAN/Tailscale, `ws://…:6768`, сервер перепривязывается на `0.0.0.0`) или через **облачный relay Orca** (`relay.onorca.dev`, обе стороны исходящие WSS), поверх — свой E2E (X25519 + HKDF + XSalsa20-Poly1305). «Как Telegram» у них даёт именно relay + закреплённый ключ из QR.
2. **coucou — не React Native.** Три нативные кодовые базы (SwiftUI, Jetpack Compose, Tauri). iPhone ↔ Mac через приватную зону CloudKit пользователя (без паринга), Android — LAN TLS с пином + свой Cloudflare Worker-relay с E2E. Анимации и иконки нарисованы кодом — переносим идеи, не библиотеки.
3. **SSH для нас ничего не покупает**: NAT не решает, RN-библиотеки SSH заброшены/без Expo/без проверки host key, TCP-сессия плохо переживает смену сети.
4. **Рекомендуемая архитектура:** RN-приложение (Expo, dev client, CNG) ↔ мост Parley на Маке. Транспорт — WebSocket/TLS-443, **всегда через Noise-E2E** (IK, ключи устройства в Keychain/Keystore). Путь доставки — сменный: (а) прямой LAN/tailnet, (б) **свой «тупой» relay-rendezvous**, куда Мак и телефон ходят исходящими соединениями (основной путь «из любой сети»). Relay не видит содержимого, хранит только маршруты. Tailscale — опция, не основа (риск РФ).
5. **Паринг:** QR `parley://pair?v=1&k=<ключ хоста>&s=<секрет>&n=<id>&r=<relay>` живёт ~2 мин, одноразовый; телефон делает Noise IKpsk рукопожатие с psk из секрета; Мак показывает «Allow <имя>?» + SAS; после этого — постоянная пара ключей, без bearer-токенов. Каждое подключение — Noise IK (1 RTT, взаимная аутентификация, forward secrecy), anti-replay по монотонному времени.
6. **Фон iOS:** сокет не держим; push «нужен ты» без содержимого (только счётчик) → тап → переподключение + снимок. Push-отправитель — свой маленький push-relay (или Expo Push на старте), а не `.p8` в каждом Маке.
7. **Хост Parley готов наполовину:** `feed.*`, `@parley/core/attention`, headless-снимок терминала, `rooms.resolveProposal` с `rev` уже есть; моста, роли `remote`, белого списка, WebSocket, паринга и push нет; `packages/protocol` использует `Buffer` в декодере строк. Результатов спайка 2026-10-01 нет (чек-лист пуст).
8. **Главный внешний блокер — Apple.** Оплатить Apple Developer из РФ в 2026 стандартными путями практически нельзя (отчёты на форуме Apple, мобильные платежи закрыты с 2026-04-01). Без членства на iPhone нет APNs, TestFlight и ad hoc. Поэтому: **Android первым** (APK/RuStore/Play), iOS-натив — после решения по аккаунту; до него iPhone получает **PWA из той же кодовой базы + Web Push** (членство не нужно) — часть старой спеки про PWA остаётся как запасной путь.
9. **iroh** (выбран 2026-10-13 для десктоп↔десктоп) для телефона сейчас не годится: официального RN-биндинга нет, в РФ без UDP он сводится к своему relay. Свой WSS-relay + Noise проще.
10. **От человека:** аккаунты (Apple: как платить; Play: карта не из РФ), где хостить relay (РФ / не РФ / несколько узлов), push-отправитель, `pty.input`/`sessions.create` с телефона (раздел 10).

## 1. Что из спеки 2026-10-01 остаётся и что меняется

| Пункт спеки | Судьба | Почему |
|---|---|---|
| Рамка §2 (выключено по умолчанию, только человек, нет `pty.input`/`settings.*`/`host.shutdown`, push без содержимого, журнал, loopback) | **Остаётся целиком** | Orca показывает, что бывает без неё: мобильный allowlist 332 метода (329 без флага `ORCA_SIDEBAR_INPUTS`) с `settings.update`(`agentDefaultArgs/Env`), `agent.launch`, `git.push`, по умолчанию `full-access` (YOLO) — O/src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-routing.ts, O/src/shared/default-global-settings.ts#L223-L229 |
| Мост `packages/remote` на `127.0.0.1`, мультиплексирование подписок, сокет управления, вторая граница (роль `remote` в `server.ts`) | **Остаётся** | Нужен независимо от клиента; хост сейчас пускает любого клиента ко всем ~140 методам (`packages/host/src/server.ts:97-164`) |
| `@parley/protocol/remote`, `remote-client` без UI | **Остаётся, становится главным** | RN берёт `remote-client` целиком; нужен вход без `Buffer` (сейчас `packages/protocol/src/framing.ts:52-69`) |
| Белый список этапов A/B (§6.3) | **Остаётся** | Совпадает с классификацией текущих методов (раздел 7) |
| Сменный фасад (Tailscale Serve / Headscale / relay) | **Меняется**: основной путь — свой relay + E2E с первого дня; Tailscale/LAN — прямой «быстрый путь» | Требование «из любой сети без настройки»; риск Tailscale в РФ; нативный клиент легко держит ключи |
| Bearer-токен 32 Б + ротация 7 дней + окно 3 токенов + Web Locks | **Заменяется** парой ключей Noise (ключ устройства в Keychain/Keystore) | Ротация токенов была костылём под PWA/iOS service worker; нативному клиенту проще и безопаснее статический ключ |
| E2E «этап C» | **Переезжает в MVP**, схема Noise IK вместо Orca-схемы (у Orca нет FS со стороны десктопа) | Relay недоверенный |
| QR `https://<фасад>/pair#o=…` + 8-значный код как основной путь на iOS | **Меняется**: QR основной (камера в приложении/системная + `parley://`), код — запасной с обязательным SAS/PAKE | Фрагмент URL и «Добавить на экран Домой» больше не нужны |
| Web Push/VAPID, service worker, CSP, раздача PWA | **Уходит из основного пути, остаётся запасным для iOS** (раздел 11.2); Host/Origin-проверки остаются | Нативно — APNs/FCM; но без платного Apple-аккаунта iPhone получает только PWA + Web Push |
| Push только переход «не ждёт → ждёт», счётчик, подавление по присутствию | **Остаётся** | Логика уже в `@parley/core/attention` (`packages/core/src/work/attention.ts`) |
| Журнал `audit.jsonl`, лимиты не по адресу, ≤5 устройств | **Остаётся** | |
| Спайк §11.2 | **Результатов нет** (`remote-spike/.state.json`: `"subs": []`, чек-лист пуст) — нужен новый, под RN | |

## 2. Сравнение: coucou / Orca / рекомендуемое для Parley

| | coucou (C) | Orca (O) | Parley (рекомендация) |
|---|---|---|---|
| Клиент | Нативно: SwiftUI (iPhone), Compose (Android) — C/README.md#L14-L22 | Expo 55 / RN 0.83, expo-router — O/mobile/package.json | Expo SDK 58 (RN 0.88), dev client + CNG |
| Связь вне LAN | iPhone: приватная зона CloudKit (C/NotchBuddy/Sources/Phone/PhoneLink.swift#L213-L260); Android: Cloudflare Worker-relay, который юзер деплоит себе (C/docs/RELAY_LINK.md#L8-L72) | Облачный relay Orca: director `relay.onorca.dev`, `wss://<cell>/v1/connect/<relayHostId>`, привязан к облачному аккаунту (O/src/main/orca-profiles/profile-cloud-auth-config.ts#L24-L27, O/mobile/src/transport/mobile-relay-connect-url.ts) | Свой relay-rendezvous (WSS-443), можно self-host; адрес в QR |
| Связь в LAN | TCP+TLS с пином сертификата, mDNS (C/docs/ANDROID_LINK.md#L11-L17) | `ws://` порт 6768, перепривязка на `0.0.0.0` при создании оффера (O/src/main/runtime/runtime-rpc/runtime-rpc-network-exposure.ts#L6-L60) | Тот же Noise поверх WS; LAN/tailnet — «быстрый путь», без `0.0.0.0` по умолчанию |
| Выбор пути | LAN 2,5 с → relay; каждые 90 с и при смене сети проба LAN (C/android/.../link/Transport.kt#L19-L102) | Гонка direct vs relay при паринге, гистерезис 3 пробы/30 с (O/mobile/src/transport/mobile-endpoint-supervisor.ts) | Как у Orca: гонка, предпочтение direct с гистерезисом |
| QR | `coucou://pair?v=1&host&port&fp&token&name[&relay&room&key&access]` (C/windows/src-tauri/src/phone_link/pairing.rs#L91-L144) | `orca://pair?code=<base64url JSON v2>`: endpoint, deviceToken, publicKeyB64, relay{…inviteToken ≤10 мин} (O/src/shared/mobile-relay-pairing-offer.ts#L45-L104) | `parley://pair?v=1&k&s&n&r` ≤150 Б (QR V8-M) |
| Подтверждение на десктопе | — (QR = секрет) | Нет: запись устройства создаётся уже при выдаче QR (device-registry.ts:70-92), первое подключение с токеном сразу `ready`; кнопка «Pair» только на телефоне (O/src/main/runtime/rpc/e2ee-channel.ts#L240-L275) | **Да**: диалог «Allow …?» + SAS |
| Крипто | HKDF от секрета K из QR, AES-256-GCM, без FS (C/docs/RELAY_LINK.md#L74-L178) | Эфемерный X25519 телефона × статический ключ десктопа, HKDF-SHA256 с хэшем транскрипта, XSalsa20-Poly1305 со счётчиком, нет эфемерного ключа десктопа → нет FS (O/src/shared/paired-e2ee-v2-key-schedule.ts, O/src/main/runtime/rpc/mobile-e2ee-v2-desktop-session.ts#L38-L69) | Noise IK (взаимные статические ключи + эфемерные с обеих сторон → FS) |
| Секреты на телефоне | Android Keystore AES-GCM обёртка (C/android/.../app/SecureStore.kt) | expo-secure-store `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (O/mobile/src/transport/host-device-token-store.ts) | `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, не синхронизируемый |
| Несколько хостов | Нет (одна пара) | Да, список хостов (O/mobile/src/transport/host-store.ts) | Да, отдельный ключ устройства на хост |
| Терминал | Нет эмулятора; структурный «последний ход» (C/NotchBuddy/Sources/CoucouKit/TurnSnapshot.swift) | xterm.js 6 beta + WebGL в WebView, бинарные кадры snapshot/output (O/mobile/src/terminal/TerminalWebView.tsx) | Лента `feed.*` — основной вид; xterm в WebView — только просмотр |
| Push | iPhone: CloudKit-подписки + Live Activity через свой Worker с `.p8`; Android: без FCM, foreground service | Десктоп → `push.onorca.dev` → APNs/FCM, **заголовок и текст в открытом виде** (O/src/main/runtime/push/push-dispatcher.ts#L177-L192) | Push-relay без содержимого: `{kind, count, hostId}` |
| Allow/Deny | Биометрия на Allow, отпечаток запроса, TTL 120 с (C/docs/ANDROID_LINK.md#L64-L82) | Через RPC | `feed.decide` (`applied:false` при гонке) + опционально биометрия |
| Сборка | Xcode/Gradle | fastlane → TestFlight, без eas.json | EAS Build/Submit (Free → Starter) |

## 3. Рекомендуемая архитектура

```
 iPhone / Android (Expo RN)
   remote-client (TS, без UI): хосты, Noise, переподключение, снимок+события
        │  WSS :443                                   ▲ APNs/FCM: {kind:'needs-you', count, hostId}
        ├──────────────► relay-rendezvous (свой, тупой) ◄──── WSS (исходящее) ──┐
        │                маршрут = H(ключ хоста); видит только шифротекст        │
        └──── прямой путь: LAN / tailnet (ws, тот же Noise) ──┐                  │
                                                              ▼                  │
                                          packages/remote — мост на Маке ────────┘
                                          Noise IK, устройства, белый список, журнал,
                                          push-сигналы, сокет управления
                                                   │ unix-сокет, hello{client:'remote'}
                                                   ▼
                                          packages/host (+ проверка роли remote)
```

- **Мост** как в спеке (§3.2), но: слушает `127.0.0.1` для прямого пути и держит **исходящее** соединение к relay; всё общение с телефоном — внутри Noise-сессии; прикладной протокол — тот же JSON `{id,method,params}` / `{event,data}` (спека §6.1–6.2) внутри шифрованных кадров.
- **Relay** — маленький сервис (Node/Go или Cloudflare Worker+DO как у coucou), задачи: склейка двух сокетов по маршруту, аутентификация «это зарегистрированное устройство этого маршрута» (HMAC, без содержимого), ping/pong, лимиты. Плюс `push.send` — отправка APNs/FCM по просьбе моста (держит `.p8`/FCM-ключ). Хостинг — решение человека (раздел 10).
- **Прямой путь** — для LAN/tailnet. Мост не слушает `0.0.0.0` по умолчанию; для LAN — отдельный переключатель (или только tailnet-адрес).
- **Источник истины — хост.** Телефон держит снимок + курсор событий; при разрыве — переподписка и новый снимок (как Orca: O/mobile/src/transport/rpc-client-stream-registry.ts#L87-L119; как Telegram `updates.getDifference`: https://core.telegram.org/api/updates).

## 4. Транспорт и доступность

**SSH против WebSocket.** SSH не решает достижимость (всё равно нужен порт/VPN/relay), требует включить Remote Login на Маке, RN-библиотеки (`react-native-ssh-sftp` и форки) на NMSSH/JSch, без Expo-плагина, без проверки host key («Host key verification is not performed» — https://github.com/dylankenneally/react-native-ssh-sftp), под New Architecture не проверены; SSH поверх TCP «does not support roaming among IP addresses» (https://mosh.org/mosh-paper.pdf). Ограниченный ключ (`command=`, `restrict` в authorized_keys — https://man.openbsd.org/sshd.8) дал бы только то, что мост и так даёт белым списком. Вывод: **SSH не берём**.

**Варианты доставки:**

| Вариант | Настройка у человека | РФ | Доверие | Вердикт |
|---|---|---|---|---|
| Tailscale (Serve) | Приложение Tailscale + VPN на телефоне (один VPN за раз) | 451 на control/DERP 2024-10-01/02, затем откат; в 2026 отчёты пользователей противоречивы (и «не работает», и «работает») | WireGuard своего tailnet | Опция «прямого пути» |
| Headscale на своём VPS | VPS + официальное приложение Tailscale с custom server | зависит от VPS; UDP режут | свой | Для продвинутых |
| Cloudflare Tunnel / Worker | Аккаунт CF (coucou так делает) | Cloudflare в РФ режется с июня 2025 | CF терминирует TLS → нужен E2E | Не основной для РФ |
| WebRTC P2P (STUN/TURN) | нет | STUN детектируется ТСПУ (звонки блокируются с 08.2025) | — | Нет |
| **Свой relay WSS-443 + Noise E2E** | **никакой** (адрес в QR) | зависит от хостинга; можно несколько узлов, один — в РФ | relay видит только метаданные | **Основной** |

**Переподключение** (по образцу Orca и coucou):
- триггеры: `AppState → active`, смена сети (`@react-native-community/netinfo` или `expo-network`), ошибка ping; reachability URL NetInfo по умолчанию — Google, заменить на свой (https://github.com/react-native-netinfo/react-native-netinfo);
- прикладной heartbeat (из RN нельзя слать WS ping-фреймы): ping 15–20 с, тишина 20 с → проба 4–8 с;
- backoff с джиттером 0,5 → 30–60 с, сброс по `AppState active`; после успешного рукопожатия — переподписка и снимок;
- каждое переподключение — новое Noise-рукопожатие (1 RTT), сессионные тикеты не нужны.

**Фон.**
- iOS: через ~5 с после ухода в фон процесс приостанавливается; silent push «не гарантирован… не больше 2–3 в час» (https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app); VoIP push только с CallKit — не наш случай. Держим соединение ~30 с «grace» (как Orca, O/mobile/src/transport/mobile-relay-background-grace.ts), дальше — только видимые push.
- Android: Doze рубит сеть; FCM high-priority без видимого уведомления понижается; foreground service `dataSync` ограничен 6 ч/сутки на Android 15. Держать постоянный сокет не пытаемся (coucou пытается через FGS `specialUse` + alarm и сам пишет, что надёжно только с «Battery: Unrestricted»).
- Задержка: relay добавляет десятки мс к RTT сотовой сети — для ленты и решений несущественно; для терминала важнее отдавать снимки/диффы экрана, а не сырой поток (урок Mosh).

## 5. Паринг «как Telegram» и соединение

Примитивы: `Noise_IKpsk2_25519_ChaChaPoly_SHA256` (паринг), `Noise_IK_25519_ChaChaPoly_SHA256` (каждое подключение). Ключи: `HS` — статический X25519 хоста; `DS_h` — статический X25519 телефона, **отдельный на каждый хост**; `e` — эфемерные.

**A. Оффер (QR)**
1. Мак → Settings → «Pair a device»: `s = rand(16)`, `n = rand(4)`, срок ~2 мин, одноразовый, один живой оффер, авто-перевыпуск после истечения (Telegram: токен ~30 с, перевыпуск — https://core.telegram.org/api/qr-login).
2. QR: `parley://pair?v=1&k=<b64url HS_pub>&s=<b64url s>&n=<b64url n>&r=<relay host>` ≈ 105–140 Б → QR V8, коррекция M (≤152 Б). `hostId = b64url(SHA256("parley-host-v1"‖HS_pub))[0:16]`. Секрет — только `s`; `k` пиннится оптикой.
3. Запасной путь — 8 знаков base32 (40 бит) вместо `s`: только с обязательным SAS или PAKE (SPAKE2/PBKDF2 как WhatsApp), иначе офлайн-перебор.

**B. Паринг (через недоверенный relay)**
1. Телефон генерирует `DS_h`, кладёт в Keychain/Keystore.
2. → msg1 IKpsk2: `e, es, s, ss` + payload `{v, n, deviceName, platform, ts}`; prologue `"parley-pair/1"‖n`; `psk = HKDF(s, "parley-psk-v1")`.
3. Мак проверяет `n`, срок; неверный psk → оффер сожжён (одна попытка).
4. Мак показывает «Allow “<имя> (unverified)” to control Parley?» + отпечаток + SAS (6 цифр из `HKDF(h,"parley-sas")`).
5. ← msg2 `e, ee, se` + `{hostName, deviceId, relayRouteSecret}` — только после «Allow».
6. Обе стороны сохраняют ключи. Bearer-токенов нет. MITM relay невозможен: нужен приватный `HS` (пин из QR) и `s` (одна попытка + подтверждение на Маке).

**C. Каждое подключение**
1. Телефон → relay: `CONNECT route=b64url(HKDF(HS_pub,"parley-route-v1"))[0:16]`, `auth=HMAC(relayRouteSecret, relayNonce)`; relay пускает только устройства, которые зарегистрировал мост.
2. → msg1 IK `e, es, s, ss` + `{ts: TAI64N}` (без прикладных данных: payload 1-го сообщения IK повторяем — Noise §7.7: payload msg1 — destination 2, msg2 — 4, транспорт — 5).
3. Мост: `DS_pub` нет в `devices.json` → молча рвёт; `ts ≤ lastTs[device]` → повтор, отказ (как WireGuard).
4. ← msg2 `e, ee, se` + hello-ответ (`hostId, methods, events, versions`).
5. Транспорт ChaChaPoly, ключи на направление, nonce-счётчик; ре-рукопожатие при каждом переподключении и не реже раза в час.

**D. Хранение, ротация, отзыв**
- Телефон: `DS_h_priv` — Keychain generic password, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, `synchronizable=false` (не уезжает на новое устройство и из бэкапа); Android — шифрование ключом Keystore (StrongBox из EC держит только P-256). Secure Enclave из EC-кривых тоже только P-256 (плюс ML-KEM в CryptoKit), X25519 не поддерживает → ключ X25519 хранится как секрет под защитой Keychain/Keystore, не как аппаратный.
- Мак: `HS_priv` — macOS Keychain (fallback — файл 0600); `devices.json` — только публичные ключи `{deviceId, DS_pub, name, pairedAt, lastSeen, lastTs}`: утечка файла не даёт входа.
- Ротация ключа устройства — `device.rotate{newPub}` внутри сессии; ротация `HS` = «Revoke all».
- Отзыв: удалить `DS_pub`, `relay.removeDevice`, закрыть сокеты 4401.
- Потеря телефона: отзыв с Мака (или «Revoke all»); переустановка приложения → новый паринг (ключи ThisDeviceOnly; при первом запуске стирать остатки Keychain).
- Несколько хостов: список `{hostId, HS_pub, relay, deviceId, hostName}`; несколько телефонов: лимит 5.

**E. Библиотеки**
- RN: `react-native-quick-crypto` 1.x (X25519, HKDF, ChaCha20-Poly1305, Nitro) **или** `@noble/curves`+`@noble/ciphers`+`@noble/hashes` (чистый JS, тот же код на Node; скорость на Hermes замерить). `react-native-libsodium` и `expo-crypto` не подходят для X25519 DH (нет `crypto_scalarmult`/`crypto_kx` / только хэши+AES).
- Node: встроенный `crypto` (x25519, chacha20-poly1305, hkdf).
- Noise: `noise-handshake` (holepunch) поддерживает только psk0 → либо паринг на IKpsk0, либо своя машина состояний (~300–400 строк) по спецификации с тест-векторами cacophony.

## 6. RN-стек

| Слой | Выбор | Заметки |
|---|---|---|
| Рантайм | Expo SDK 58 / RN 0.88, New Architecture (обязательна с SDK 55), TS, Hermes | Orca на Expo 55 / RN 0.83 — подтверждает путь |
| Нативная сборка | `expo-dev-client` + CNG/prebuild + config plugins; bare не нужен | нативный крипто и WebView работают в dev build |
| Сборка/выкладка | EAS Free (15+15 сборок/мес) → Starter $19; EAS Submit; EAS Update — только JS | Orca обходится fastlane |
| Навигация | `expo-router` (native Stack + native tabs), схема `parley://` | с SDK 56 прямые импорты `@react-navigation/*` не поддерживаются (есть codemod) |
| Состояние | zustand (как в окне) + свой WS-клиент/редьюсер из `remote-client`; снимок + курсор, детекция пропусков → ресинк | TanStack Query — не нужен на старте |
| Офлайн-кэш | `expo-sqlite` (при чувствительных данных — SQLCipher) или MMKV v4 | решения офлайн не принимаются |
| Лента/чат | FlashList v2 (`startRenderingFromBottom`); Legend List — кандидат в спайк | Orca на FlatList |
| Markdown | `react-native-enriched-markdown` (нативный текст, GFM, стриминг, tree-sitter) → запасной `@ronradtke/react-native-markdown-display` | Orca: markdown-it → mdast → свои RN-компоненты |
| Терминал | `@xterm/xterm` в `react-native-webview` (бандл локально), только просмотр, снимок `@xterm/addon-serialize` с хоста пишется напрямую; батчинг + flow control | так же у Orca; нативные SwiftTerm/Termux — только если упрёмся |
| Анимации | Reanimated 4.7 + worklets, Gesture Handler 3; Moti — нет (Reanimated 3) | пружины/кривые coucou переносятся формулами |
| Иконки/облик | `expo-symbols` (SF Symbols на iOS с `symbolEffect`-подобными анимациями, Material Symbols на Android), Lucide для своих; `expo-glass-effect` (iOS 26+, fallback), `expo-haptics`, `expo-blur` | ровно приёмы coucou: Liquid Glass, SF Symbols, haptics |
| Секреты | `expo-secure-store` (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) или `react-native-keychain`; биометрия на Allow — опционально | |
| Крипто | см. 5.E | |
| Push-клиент | `expo-notifications`: нативный APNs/FCM-токен, регистрация через мост | Orca так же (`getDevicePushTokenAsync`) |
| Push-отправитель | свой push-relay (`.p8` и FCM-ключ там) или Expo Push Service на старте; не класть общий `.p8` в каждый Мак | содержимое — только `{kind,count,hostId}`; NSE для расшифровки — позже |

## 7. Готовность хоста Parley (f7978af8)

Есть:
- `feed.snapshot/subscribe/unsubscribe/decide/interrupt/progress`, `decide → {applied,state}` (`packages/protocol/src/methods.ts:300-320`, `packages/host/src/feed/feed-service.ts:161-188`);
- `@parley/core/attention` вынесен (`packages/core/src/work/attention.ts`, `packages/core/package.json:15`);
- headless-экран `@xterm/headless` + `@xterm/addon-serialize` (`packages/host/src/pty/screen.ts:14-47`), `pty.attach` со снимком, `pty.resync` медленным;
- `rooms.resolveProposal` с `rev` (опциональным); несовпадение отвергает `packages/core/src/work/proposals.ts:162-165` через `rooms-service.ts:238-250`;
- `works.list` с вариантами снимка по `hello.features` (`packages/host/src/methods/works.ts:22-44`) — телефон должен слать `compact-works`, `rooms-mail`;
- Telegram-канал (карточки, `feed.decide`, `resolveRoomProposal`) — уже работающий «телефонный» путь (`packages/host/src/telegram/service.ts:573, 650-658`).

Нет:
- `packages/remote*`, `@parley/protocol/remote`, `@parley/host/client` (рукопожатие живёт в `packages/desktop/src/main/host-connection.ts`);
- проверки роли / белого списка: все клиенты получают все методы; токен сравнивается `!==` (`packages/host/src/server.ts:119`);
- TCP/WebSocket: хост — только unix-сокет NDJSON;
- `packages/protocol` использует глобальный `Buffer` в `LineDecoder` (`framing.ts:51-69`): импорт корня не падает, но декодер строк в RN без полифилла не работает → отдельный вход без framing чище;
- паринга, устройств, push; результатов спайка (`remote-spike/README.md:60-75` — чек-лист пуст, `.state.json:7` `"subs": []`; что его ни разу не запускали — вывод, не факт).
- Методов хоста 140 (+`hello`), уведомлений 3, событий 19 — классификация «чтение / можно телефону / запрещено» в отчёте D6 (s-83).

## 8. Этапы

- **Этап 0 — спайк (1 нед).** Expo dev build на iPhone и Android: QR-скан, Noise IK (quick-crypto vs noble на Hermes), WS через тестовый relay из РФ-мобильной сети и Wi-Fi (несколько хостингов: зарубежный VPS, РФ-хостинг, CF Worker), фон/возврат, APNs через relay, xterm в WebView на реальном снимке, размер `works.changed`. Решить вопрос аккаунтов: Apple (из РФ стандартно не оплачивается, 11.2) и Play (карта не из РФ); собрать dev build на свой iPhone через бесплатный Personal Team (без push).
- **Этап A — MVP «видеть и решать» (3–4 нед).** Хост: роль `remote` + белый список A/B-light; мост (`127.0.0.1` + исходящий к relay), Noise, паринг с подтверждением на Маке, журнал; relay v1; `remote-client`; приложение: хосты/паринг, работы по вниманию, сессии со статусом, комнаты + `DecisionCard` (Accept/Return с `rev`), карточки разрешений `feed.decide`, push «N waiting». Android: APK/RuStore сразу, закрытый тест Play (12 × 14 дней); iOS: TestFlight при наличии аккаунта, иначе PWA-сборка той же кодовой базы с Web Push.
- **Этап B — «вести» (3–5 нед).** Лента комнаты с вводом и `@`, `rooms.send`, `pty.send`, лента сессии `feed.*`, терминал только просмотр, Resume/Stop, офлайн-кэш, несколько хостов, отзыв/ротация в UI.
- **Этап C — полный доступ.** `sessions.create` (за переключателем), ответы Codex (без хуков), Live Activity / виджеты, Notification Service Extension для зашифрованных деталей, iPad, Джарвис как второй клиент.

## 9. Риски

1. **Сеть РФ**: белые списки мобильного интернета (с 09.2025), блокировки Cloudflare, ТСПУ режет UDP/STUN; Tailscale 451 (2024). Любой зарубежный relay может быть недоступен в режиме whitelist → нужны замеры и, возможно, узел в РФ.
2. **App Review**: guideline 4.2.7 для клиентов, зеркалирующих конкретное ПО, требует (a) хост, принадлежащий пользователю, и **хост и клиент в одной LAN**; (b) всё исполняется на хосте. Доступ «из любой сети» через relay может быть сочтён нарушением, если Apple классифицирует приложение как remote desktop client, а не как самостоятельный companion-клиент с нативным UI [H — решение за App Review]. Ещё 2.5.2, демо-хост для ревьюера, приватность 5.1.1.
3. **Оплата Apple Developer из РФ в 2026 стандартными путями фактически невозможна**: с 2026-04-01 нет оплаты с мобильного счёта (https://support.apple.com/126891), карты РФ не принимаются, на форуме Apple — отказы (thread 850823, 840481); прямого запрета Apple нет. Google Play — бесплатные приложения публиковать можно, монетизация приостановлена с 2024-12-26. Подробнее — раздел 11.
4. **Push**: APNs/FCM требуют ключей; без своего push-relay — либо Expo Push (зависимость), либо `.p8` у каждого пользователя. FCM в РФ может быть нестабилен [H].
5. **Безопасность**: сопряжённый телефон = выполнение кода на Маке руками агента; компрометация relay даёт метаданные и DoS, не содержимое (при Noise).
6. **Терминал в WebView**: производительность/IME/копирование на длинных сессиях не замерены.
7. **Объём**: Orca — ~185 тыс. строк в `mobile/` и ~570 коммитов за октябрь; «всё, что в окне» — много. Держать рамку этапов.
8. **Новые версии**: SDK 58 вышел 2 недели назад — часть библиотек (libsodium, Enriched Markdown, Moti) с RN 0.88 не проверена.

## 10. Открытые решения для человека

1. **Relay**: свой (где хостить: зарубежный VPS / РФ-хостинг / Cloudflare Worker как у coucou / несколько узлов) или self-host у каждого пользователя? Связать ли с iroh из брейншторма 2026-10-13 (документ не в git, статус — брейншторм; iroh выбран для командного доступа) — см. раздел 11.
2. **Push-отправитель**: свой push-relay (держит `.p8`) или Expo Push Service на старте.
3. **Аккаунты и порядок платформ**: как получить Apple Developer (иностранная карта на себя / посредник / ЮЛ / отложить iOS-натив и жить на PWA); Google Play (карта не из РФ) или только APK + RuStore; Android первым — да/нет.
4. **Прямой LAN-путь**: разрешать ли мосту слушать LAN-интерфейс (Orca — `0.0.0.0` после паринга) или только loopback + tailnet + relay.
5. **Сырой ввод в терминал** (`pty.input`) и **запуск сессий** (`sessions.create`) с телефона — спека запрещает/откладывает; подтвердить.
6. **Биометрия** на Allow (как coucou) — по умолчанию вкл/выкл.
7. **Telegram-канал**: оставить как «нулевой» мобильный путь до выхода приложения?
8. **Минимальные ОС**: iOS 17/18+, Android 11+ (coucou: iOS 18, Android 11).

## 11. Две добавочные развилки (вторая волна)

### 11.1 iroh как транспорт телефона

- iroh 1.0 вышел 2026-06-15, текущий 1.4.1 (2026-10-22): dial по Ed25519-ключу, QUIC + TLS 1.3, hole-punching, иначе — relay по TCP 443 (HTTPS → WebSocket). Если UDP режется, весь трафик идёт через relay. Дефолтные relay n0 — «для dev/test», в проде нужен свой `iroh-relay` (https://github.com/n0-computer/iroh/releases, https://docs.iroh.computer/configuring-networks).
- Официальные биндинги iroh-ffi: Swift, Kotlin, Python, Node (napi). **Официального RN-биндинга нет**. Есть сторонний alpha `react-native-iroh-ffi` (1 автор; пример на Expo SDK 57; Android проверен только на эмуляторе). Открыт issue #4289: на iOS после suspend/resume эндпоинт может умереть насовсем (в 1.0.0 есть связанный fix #4314, на 1.4.1 воспроизводимость не доказана) (https://github.com/n0-computer/iroh-ffi, https://github.com/yyq1025/react-native-iroh-ffi, https://github.com/n0-computer/iroh/issues/4289).
- **Вывод:** для телефон↔Мак из РФ преимущество «p2p без сервера» исчезает: UDP режут, relay всё равно свой. Свой WSS-relay + Noise IK проще: чистый TS в RN, без нативного Rust-модуля. iroh оставить для десктоп↔десктоп (брейншторм 2026-10-13). Пересмотреть, когда появится официальный RN-биндинг. Если relay сделать совместимым по форме (WSS-443, маршрут = ключ), переход позже возможен [H].

### 11.2 Публикация на iOS и Android из РФ

- **Apple Developer Program ($99/год) из РФ в 2026 стандартно не оплачивается.** Карты РФ и «Мир» отклоняются, баланс Apple Account не принимается, заказы «приняты, но не списаны», поддержка не помогает. Источники — отчёты пользователей на форуме Apple: threads 850823, 852940, 826740 (2026), продление 840481. Мобильные платежи закрыты с 2026-04-01 (https://support.apple.com/126891). Прямого запрета от Apple нет. Обходы известны только из рекламных блогов: иностранная карта (Армения, Киргизия, Турция) с правдивыми данными на себя, посредник-держатель аккаунта, ЮЛ за рубежом. Успешных подтверждённых кейсов после 2026-04 нет.
- **Без членства:**
  - бесплатный Personal Team: профили на 7 дней, до 3 устройств, **без Push Notifications** (Apple DTS, forums thread 768748);
  - ad hoc и TestFlight требуют платного аккаунта (https://docs.expo.dev/build/internal-distribution/);
  - AltStore/SideStore — те же 7 дней и без push [H].
- **PWA на iOS жива:** в iOS 26 любой сайт с экрана «Домой» открывается как web app; Web Push для таких приложений остаётся (Declarative Web Push с iOS 18.4) и **не требует членства** (https://webkit.org/blog/17333, https://webkit.org/blog/16535).
- **Android:**
  - прямой APK или RuStore — без препятствий;
  - Google Play: $25, карта не из РФ; личный аккаунт → закрытый тест 12 тестеров × 14 дней; бесплатные приложения публиковать можно;
  - верификация разработчиков Android стартовала 2026-09-30 в четырёх странах (Бразилия, Индонезия, Сингапур, Таиланд), глобально — в 2027; установка по ADB остаётся, бесплатная limited distribution — до 20 устройств (https://developer.android.com/developer-verification/guides/faq); что РФ попадёт под ограничения — только вторичный источник.
- **Следствие для плана:**
  1. Нативное RN-приложение делаем, но **первым выпускаем Android** (APK, RuStore, Play).
  2. iOS-натив — после решения человека по аккаунту Apple.
  3. Пока аккаунта нет, iOS получает **PWA из той же кодовой базы**: Expo Router умеет web, `remote-client` общий [H — сборку web из этого стека дроны не проверяли]. Push в PWA — Web Push (VAPID) от моста, как в старой спеке §7. Поэтому часть спеки про PWA и Web Push **не выбрасываем, а оставляем запасным путём для iOS**.
  4. Для своей разработки на iPhone хватает бесплатного Personal Team, но без push.

## 12. Проверка и покрытие

**Рой:** 9 дронов, 5 верификаторов. Все сдали. Частичное покрытие у D2 (Orca), D3, D4 и D5; пробелы закрыты вторым дроном по Orca (D2b), второй волной (D8, D9) и верификацией.

**Подтверждено верификаторами [V]:**
- coucou C1–C8;
- Orca O1–O7 и перекрёстно двумя дронами;
- транспорт и крипто T2, T4–T13, T15;
- RN-стек и публикация R1, R2, R4–R14, R16;
- Parley P1–P13, P15;
- iroh и iOS I1–I3, I5, A1–A5, G1.

**Исправлено верификаторами:**
- у Orca 332 метода, а не ≈298 или 330;
- устройство Orca пишется в реестр при выдаче QR;
- Secure Enclave из EC-кривых держит только P-256, но есть ML-KEM;
- статус Tailscale в РФ в 2026 противоречив;
- импорты `@react-navigation/*` «не поддерживаются», а не «запрещены»;
- `Buffer` нужен только `LineDecoder`;
- `hello` + 140 методов;
- пример RN-iroh собран на Expo 57;
- оплата Apple из РФ фактически закрыта (R15, A5).

**Поправка к прошлой разведке:** облачный relay и E2EE v2 у Orca были уже на `6d1a97e` (2026-10-01). Спека их упустила (O5 [V]).

**Не подтверждено [D/H]:**
- протокол паринга и соединения (раздел 5) — проект дрона D4 по источникам; отдельного криптоаудита или ревью критиком не было, нужен до реализации;
- T1: текущая блокировка Tailscale;
- T3: отсутствие официального RN-модуля Tailscale;
- T16: WhatsApp-whitepaper, прочитана только копия;
- P14: брейншторм iroh не в git;
- P16: спайк «никогда не запускали»;
- R15: прямого запрета Apple нет, есть только платёжные отказы;
- производительность xterm в WebView, noble против quick-crypto на Hermes, размер `works.changed`.

**Не покрыто:**
- живые замеры сети из РФ (relay, APNs, FCM);
- сборка выбранного стека на SDK 58;
- UI-экраны Orca и coucou на Android целиком;
- серверная часть Orca relay (`cloud/apps/relay`);
- полный разбор ~570 коммитов Orca в `mobile/` за октябрь;
- решения комнаты «Mobile APP» (w-0043) в истории Parley.
