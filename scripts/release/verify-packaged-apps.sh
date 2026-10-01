#!/bin/bash
# Проверка собранных .app перед публикацией релиза (план релиза 0.1.0, P2): в приложении лежит то, без
# чего оно не запустится у человека, — встроенный Node нужной архитектуры, хост, node-pty и лицензии.
# Если источника `extraResources` нет (например, не запускали `fetch-node`), electron-builder лишь
# предупреждает, и в релиз уехало бы приложение без node: эта проверка такое не пропускает.
#
# Использование: bash scripts/release/verify-packaged-apps.sh [каталог dist]
# Каталог по умолчанию — packages/desktop/dist. Ждёт, что electron-builder положил arm64 в
# <dist>/mac-arm64/Parley.app, а x64 — в <dist>/mac/Parley.app. Запуск — на macOS (codesign, lipo, plutil);
# встроенный node и node-pty запускаются только у приложения под архитектуру этой машины.
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
  [ -f "$resources/host/dist/main.js" ] || fail "$app has no host entry (Contents/Resources/host/dist/main.js)"
  [ -x "$resources/host/node_modules/node-pty/prebuilds/darwin-$pty_arch/spawn-helper" ] ||
    fail "$app: node-pty spawn-helper for darwin-$pty_arch is missing or not executable"
  for license in NOTICE licenses/Figtree-OFL.txt licenses/Caprasimo-OFL.txt; do
    [ -f "$resources/$license" ] || fail "$app has no Contents/Resources/$license"
  done
  echo "$out: ok"
}

check_app mac-arm64 arm64 arm64
check_app mac x86_64 x64

# Запуск на машине сборки: встроенный node той же версии, что закреплена в fetch-node, и хост грузит node-pty.
case "$(uname -m)" in
  arm64) native=mac-arm64 ;;
  x86_64) native=mac ;;
  *) fail "unsupported machine architecture: $(uname -m)" ;;
esac
resources="$dist/$native/Parley.app/Contents/Resources"
[ "$("$resources/node/bin/node" --version)" = "v$node_version" ] ||
  fail "$native: the embedded node is not v$node_version"
(cd "$resources/host" && "$resources/node/bin/node" -e "require('node-pty')") ||
  fail "$native: node-pty does not load under the embedded node"
echo "$native: embedded node v$node_version runs and loads node-pty"
