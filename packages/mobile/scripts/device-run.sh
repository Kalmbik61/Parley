#!/usr/bin/env bash
# Run the dev variant of the Parley iOS app on an iPhone over Wi-Fi (A20 items 16-23). See README, "Run on your iPhone over Wi-Fi".
#
#   packages/mobile/scripts/device-run.sh [--skip-build] [--no-relay] [--udid <hardware UDID>]
#
# 1. finds the Mac's LAN IPv4 and starts the dev relay on it (prints the ws:// address);
# 2. builds the Release configuration of the DEV variant for iphoneos (embedded JS bundle: no Metro, no cable after the
#    install; optimised Hermes, so the Bench numbers count; ws:// to a private address stays allowed through extra.devBuild);
# 3. signs with the Personal Team found in the keychain, installs and launches with devicectl;
# 4. keeps the relay running until Ctrl-C.
set -euo pipefail

MOBILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$MOBILE/../.." && pwd)"
UDID="${PARLEY_DEVICE_UDID:-00008150-001179DA0E50C01C}"   # iPhone 17 Pro "Kalmbik"
BUILD=1 RELAY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) BUILD=0 ;;
    --no-relay) RELAY=0 ;;
    --udid) UDID="$2"; shift ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# The default bundle id (dev.example...) is not registrable; any id unique across Apple accounts works.
export PARLEY_MOBILE_BUNDLE_ID="${PARLEY_MOBILE_BUNDLE_ID:-com.$(id -un | tr -c 'a-zA-Z0-9\n' '-').parley.mobile}"
export APP_VARIANT=dev
DERIVED="${PARLEY_DERIVED:-$HOME/.cache/parley-mobile-device-derived}"
LOGS="${TMPDIR:-/tmp}/parley-device-run"; mkdir -p "$LOGS"
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

# ---- 1. LAN address and the dev relay -------------------------------------------------------------------------------
IFACE="$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')"
LAN_IP="$(ipconfig getifaddr "${IFACE:-en0}" 2>/dev/null || true)"
[ -n "$LAN_IP" ] || die "no LAN IPv4 on ${IFACE:-en0}: join the same Wi-Fi network as the iPhone"
# First free port from 8787 (another dev relay may be running); PORT=... forces one.
if [ -z "${PORT:-}" ]; then
  for p in $(seq 8787 8799); do lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || { PORT=$p; break; }; done
fi
[ -n "${PORT:-}" ] || die "no free port in 8787-8799; set PORT"
RELAY_PID=""
cleanup() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ "$RELAY" = 1 ]; then
  say "Dev relay on $LAN_IP (plain ws://, in memory)"
  (cd "$ROOT" && pnpm --filter @parley/relay build >/dev/null)
  (cd "$ROOT/packages/relay" && HOST="$LAN_IP" PORT="$PORT" exec node dist/main.js --dev) >"$LOGS/relay.log" 2>&1 &
  RELAY_PID=$!
  for _ in $(seq 1 30); do grep -q 'ws://' "$LOGS/relay.log" 2>/dev/null && break; kill -0 "$RELAY_PID" 2>/dev/null || break; sleep 0.5; done
  RELAY_WS="$(grep -o 'ws://[^ ]*' "$LOGS/relay.log" | head -1 || true)"
  [ -n "$RELAY_WS" ] || { cat "$LOGS/relay.log" >&2; die "the relay did not start (port busy? see $LOGS/relay.log)"; }
else
  RELAY_WS="ws://$LAN_IP:$PORT"
fi
curl -fsS --max-time 3 "http://${RELAY_WS#ws://}/v1/health" >/dev/null || die "relay health check failed at $RELAY_WS"
echo "Relay: $RELAY_WS   (log: $LOGS/relay.log)"
cat <<EOT

    IN THE PARLEY WINDOW (this Mac): Settings > Remote access > turn it on, put
        ${RELAY_WS#ws://}
    into the Relay field, then open "Pair a phone" to show the QR code. The script does not touch the window:
    the control socket needs the window's own token, so it is two taps by hand.
EOT

# ---- 2. Build -------------------------------------------------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  command -v pod >/dev/null || die "CocoaPods is missing (brew install cocoapods)"
  TEAM="$(security find-certificate -c 'Apple Development' -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU=\([A-Z0-9]*\).*/\1/p' | head -1)"
  [ -n "$TEAM" ] || die "no 'Apple Development' identity in the keychain: Xcode > Settings > Accounts > add the Apple ID, Manage Certificates > + Apple Development"
  echo "Team: $TEAM   Bundle id: $PARLEY_MOBILE_BUNDLE_ID"

  # Release archives of React Native and Hermes (one Hermes tarball serves every configuration, so it must be the optimised one).
  A="${PARLEY_RN_ARTIFACTS:-$HOME/rn-artifacts/0.88.1}"
  M=https://maven-central.storage-download.googleapis.com/maven2/com/facebook
  mkdir -p "$A"
  for f in react/react-native-artifacts/0.88.1/react-native-artifacts-0.88.1-reactnative-core-release.tar.gz \
           react/react-native-artifacts/0.88.1/react-native-artifacts-0.88.1-reactnative-dependencies-release.tar.gz \
           hermes/hermes-ios/260318099.0.5/hermes-ios-260318099.0.5-hermes-ios-release.tar.gz; do
    b="$(basename "$f")"
    if [ ! -f "$A/$b" ]; then say "Downloading $b (Google mirror of Maven Central)"; (cd "$A" && curl -fL -O "$M/$f" -O "$M/$f.sha256"); fi
    [ "$(shasum -a 256 "$A/$b" | awk '{print $1}')" = "$(cat "$A/$b.sha256")" ] || die "checksum mismatch: $A/$b (delete it and run again)"
  done
  export RCT_TESTONLY_RNCORE_TARBALL_PATH="$A/react-native-artifacts-0.88.1-reactnative-core-release.tar.gz"
  export RCT_USE_LOCAL_RN_DEP="$A/react-native-artifacts-0.88.1-reactnative-dependencies-release.tar.gz"
  export HERMES_ENGINE_TARBALL_PATH="$A/hermes-ios-260318099.0.5-hermes-ios-release.tar.gz"

  say "Workspace packages"
  (cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null && pnpm -r build >"$LOGS/build.log" 2>&1) || { tail -20 "$LOGS/build.log"; die "pnpm -r build failed"; }
  say "expo prebuild + pod install (ios/ is regenerated)"
  (cd "$MOBILE" && pnpm exec expo prebuild --platform ios --clean --no-install >"$LOGS/prebuild.log" 2>&1 && cd ios && pod install >>"$LOGS/prebuild.log" 2>&1) || { tail -30 "$LOGS/prebuild.log"; die "prebuild/pod install failed"; }
  say "xcodebuild -sdk iphoneos, Release (10-20 minutes the first time; log: $LOGS/xcodebuild.log)"
  (cd "$MOBILE" && xcodebuild -workspace ios/Parley.xcworkspace -scheme Parley -configuration Release -sdk iphoneos \
      -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
      DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="$PARLEY_MOBILE_BUNDLE_ID" build) >"$LOGS/xcodebuild.log" 2>&1 \
    || { grep -E "error:|Provisioning|No Account|Signing" "$LOGS/xcodebuild.log" | head -15 >&2; die "xcodebuild failed (see $LOGS/xcodebuild.log). 'No Account' or 'No profiles' = Xcode > Settings > Accounts is missing the Apple ID; 'bundle identifier is not available' = set PARLEY_MOBILE_BUNDLE_ID to another id"; }
  echo "Built: $DERIVED/Build/Products/Release-iphoneos/Parley.app"
fi
APP="$DERIVED/Build/Products/Release-iphoneos/Parley.app"
[ -d "$APP" ] || die "no build at $APP: run without --skip-build"

# ---- 3. The phone ---------------------------------------------------------------------------------------------------
JSON="$LOGS/devices.json"
xcrun devicectl list devices --json-output "$JSON" >/dev/null 2>&1 || true
STATE="$(node -e '
  const [f, udid] = process.argv.slice(1);
  try {
    const d = (JSON.parse(require("fs").readFileSync(f, "utf8")).result?.devices ?? []).find((x) => x.hardwareProperties?.udid === udid);
    console.log(d ? `${d.connectionProperties?.tunnelState ?? "unknown"}|${d.deviceProperties?.name ?? ""}` : "absent|");
  } catch { console.log("absent|"); }
' "$JSON" "$UDID")"
case "${STATE%%|*}" in
  connected) ;;
  *) cat >&2 <<EOT

STOP: the iPhone ($UDID) is "${STATE%%|*}". The build is ready at $APP.
  Connect it by cable (or turn on Wi-Fi sync), unlock it, tap "Trust This Computer", enable Developer Mode
  (Settings > Privacy & Security > Developer Mode, then restart; the switch appears after the first install attempt),
  then run:  $0 --skip-build
EOT
     exit 3 ;;
esac

say "Installing on ${STATE#*|}"
xcrun devicectl device install app --device "$UDID" "$APP" || die "install failed. 'Developer Mode disabled' = enable it and restart the phone; 'profile has not been explicitly trusted' comes at launch"
say "Launching"
if ! xcrun devicectl device process launch --device "$UDID" "$PARLEY_MOBILE_BUNDLE_ID"; then
  cat >&2 <<EOT

The app is installed but iOS refused to start it. If it says the developer is not trusted: on the phone, Settings >
General > VPN & Device Management > Developer App > your Apple ID > Trust, then open Parley from the home screen.
EOT
fi
cat <<EOT

Done. On the phone: allow Local Network and Camera when asked, tap Scan, scan the QR code in the Parley window.
Bench: Settings > Diagnostics > Crypto bench (phone on the charger, Low Power Mode off).
The relay keeps running here until you press Ctrl-C.
EOT
if [ -n "$RELAY_PID" ]; then wait "$RELAY_PID"; fi
