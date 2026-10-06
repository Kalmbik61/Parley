#!/bin/bash
# Проверка собранных .app перед публикацией релиза (план релиза 0.1.0, P2): в приложении лежит то, без
# чего оно не запустится у человека, — встроенный Node нужной архитектуры с текстом его лицензии, хост,
# node-pty нужной архитектуры и лицензии. Если источника `extraResources` нет (например, не запускали
# `fetch-node`), electron-builder лишь предупреждает, и в релиз уехало бы приложение без node: эта проверка
# такое не пропускает.
#
# Использование: bash scripts/release/verify-packaged-apps.sh [каталог dist]
# Каталог по умолчанию — packages/desktop/dist. Ждёт, что electron-builder положил arm64 в
# <dist>/mac-arm64/Parley.app, а x64 — в <dist>/mac/Parley.app. Запуск — на macOS (codesign, lipo, plutil).
#
# Архитектуру нативных файлов (node, pty.node, spawn-helper) проверяют оба приложения. Встроенный node и
# node-pty запускаются у приложения под архитектуру этой машины и, на arm64 с Rosetta, у x64 тоже
# (`arch -x86_64`). Rosetta нет — x64 проверен только по файлам, и скрипт говорит об этом предупреждением.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dist="${1:-$root/packages/desktop/dist}"
version="$(node -p 'require(process.argv[1]).version' "$root/packages/desktop/package.json")"
# Путь — через переменную, а не аргумент: скрипт fetch-node запускает `main()`, когда он `argv[1]`.
node_version="$(FETCH_NODE="$root/packages/desktop/scripts/fetch-node.mjs" node --input-type=module -e 'const { NODE_VERSION } = await import(process.env.FETCH_NODE); console.log(NODE_VERSION)')"

fail() {
  echo "::error::$*"
  exit 1
}

# $1 — каталог вывода electron-builder, $2 — архитектура в выводе lipo, $3 — каталог prebuilds node-pty.
check_app() {
  local out="$1" lipo_arch="$2" pty_arch="$3"
  local app="$dist/$out/Parley.app"
  local resources="$app/Contents/Resources"
  local plist="$app/Contents/Info.plist"
  local pty="$resources/host/node_modules/node-pty"
  local prebuilds="$pty/prebuilds/darwin-$pty_arch"

  [ -d "$app" ] || fail "$app was not built"
  codesign --verify --deep --strict "$app" || fail "$app: codesign verification failed"
  [ "$(plutil -extract CFBundleIdentifier raw -o - "$plist")" = "dev.parley.desktop" ] ||
    fail "$plist: CFBundleIdentifier is not dev.parley.desktop"
  [ "$(plutil -extract CFBundleShortVersionString raw -o - "$plist")" = "$version" ] ||
    fail "$plist: CFBundleShortVersionString is not $version"

  [ -x "$resources/node/bin/node" ] ||
    fail "$app has no embedded node (Contents/Resources/node/bin/node): fetch-node must run before electron-builder"
  [ "$(lipo -archs "$resources/node/bin/node")" = "$lipo_arch" ] ||
    fail "$app: the embedded node is not a $lipo_arch binary"
  # Бинарь Node раздаётся вместе с текстом его лицензии (MIT, V8, OpenSSL, ICU): fetch-node кладёт LICENSE рядом.
  [ -s "$resources/node/LICENSE" ] ||
    fail "$app has no Contents/Resources/node/LICENSE: the license text of the embedded node must ship with it"
  # Движок голосового ввода своей архитектуры, модель VAD и LICENSE whisper.cpp (fetch-whisper).
  [ -x "$resources/whisper/bin/whisper-cli" ] ||
    fail "$app has no voice engine (Contents/Resources/whisper/bin/whisper-cli): fetch-whisper must run before electron-builder"
  [ "$(lipo -archs "$resources/whisper/bin/whisper-cli")" = "$lipo_arch" ] ||
    fail "$app: whisper-cli is not a $lipo_arch binary"
  [ -s "$resources/whisper/ggml-silero-v6.2.0.bin" ] || fail "$app has no VAD model (Contents/Resources/whisper/ggml-silero-v6.2.0.bin)"
  [ -s "$resources/whisper/LICENSE" ] || fail "$app has no Contents/Resources/whisper/LICENSE"
  [ -f "$resources/host/dist/main.js" ] || fail "$app has no host entry (Contents/Resources/host/dist/main.js)"

  # Нативные файлы node-pty — своей архитектуры: проверка по заголовку Mach-O, а не только по имени каталога.
  for native in pty.node spawn-helper; do
    [ -f "$prebuilds/$native" ] || fail "$app: node-pty $native for darwin-$pty_arch is missing"
    [ "$(lipo -archs "$prebuilds/$native")" = "$lipo_arch" ] ||
      fail "$app: node-pty $native for darwin-$pty_arch is not a $lipo_arch binary"
  done
  [ -x "$prebuilds/spawn-helper" ] ||
    fail "$app: node-pty spawn-helper for darwin-$pty_arch is missing or not executable"
  # node-pty ищет `build/Release` и `build/Debug` раньше prebuilds. Хост у обоих приложений один (`pnpm deploy`
  # раскладывается один раз), так что собранный из исходников `pty.node` архитектуры раннера сломал бы
  # приложение другой архитектуры, а `lipo` выше этого не заметил бы, если prebuilds остались.
  for built in build/Release build/Debug; do
    [ -z "$(find "$pty/$built" -name '*.node' 2>/dev/null | head -n 1)" ] ||
      fail "$app: node-pty has $built/*.node, which it loads before prebuilds: it must come from prebuilds only"
  done
  for license in NOTICE licenses/Figtree-OFL.txt licenses/Caprasimo-OFL.txt; do
    [ -f "$resources/$license" ] || fail "$app has no Contents/Resources/$license"
  done
  echo "$out: ok"
}

# Запуск встроенного node и загрузка node-pty. $1 — каталог вывода electron-builder, остальное — префикс
# запуска (пусто или `arch -x86_64`): node той же версии, что закреплена в fetch-node, и хост грузит node-pty.
run_app() {
  local out="$1"
  shift
  local resources="$dist/$out/Parley.app/Contents/Resources"
  [ "$("$@" "$resources/node/bin/node" --version)" = "v$node_version" ] ||
    fail "$out: the embedded node is not v$node_version"
  (cd "$resources/host" && "$@" "$resources/node/bin/node" -e "require('node-pty')") ||
    fail "$out: node-pty does not load under the embedded node"
  # whisper-cli x64 собран с AVX2, а Rosetta его не исполняет (этап 0: SIGILL, сборки без AVX там зависают): x64 под
  # `arch -x86_64` не запускаем — у него проверка заголовка (lipo выше) и библиотек (otool), а не запуск.
  if [ "$#" -eq 0 ]; then
    "$resources/whisper/bin/whisper-cli" --help >/dev/null 2>&1 || fail "$out: whisper-cli does not start"
  fi
  ! otool -L "$resources/whisper/bin/whisper-cli" | grep -q '@rpath' || fail "$out: whisper-cli links libraries from the build (@rpath)"
  echo "$out: embedded node v$node_version runs and loads node-pty"
}

check_app mac-arm64 arm64 arm64
check_app mac x86_64 x64

case "$(uname -m)" in
  arm64)
    run_app mac-arm64
    # x64 на Apple Silicon идёт через Rosetta. Её может не быть (чистый раннер) — тогда это предупреждение,
    # а не отказ: файлы x64 уже проверены выше.
    if arch -x86_64 /usr/bin/true 2>/dev/null; then
      run_app mac arch -x86_64
    else
      echo "::warning::Rosetta is not available on this machine: the x64 app was checked by its files only, its embedded node was not run"
    fi
    ;;
  x86_64) run_app mac ;;
  *) fail "unsupported machine architecture: $(uname -m)" ;;
esac
