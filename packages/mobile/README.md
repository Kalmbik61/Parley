# @parley/mobile

The Parley iOS app (iPhone only, iOS 17+): Expo SDK 58 dev client, `expo-router` native tabs (Inbox / Works / Settings),
React Native 0.88 (New Architecture, Hermes). The client core is `@parley/remote-client`; this package supplies its
`Platform` (Keychain, WebSocket, AppState, NetInfo) and the UI.

| Component    | Version                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| Expo SDK     | 58 (`expo` 58.0.21)                                                                           |
| React Native | 0.88.1, React 19.3.0                                                                          |
| Node / pnpm  | 22 / 9.12                                                                                     |
| CocoaPods    | 1.16.2                                                                                        |
| Xcode        | 27.2; simulator iPhone 17, iOS 27.2                                                           |

## Layout

- `src/platform/*` — `Platform` adapters (`key-store`, `socket`, `app-state`, `network` + `health`, `first-run`), wired in `index.ts`.
- `src/runtime/*` — the one `HostStore` per app, first-run wipe, `Supervisor` + remote-client store wiring.
- `src/components/*` — `ConnectionBanner` (D1 §4) and its pure state mapping `banner-model.ts`.
- `src/theme/*` — design tokens (D1 §17). `src/app/*` — routes. `src/dev/*` — developer-build helpers.
- `prototype/` — the D1 HTML prototype; not part of the build.

## Decisions

- **Workspace packages are built, not aliased.** `@parley/core`, `@parley/protocol` and `@parley/remote-client` export
  `dist/`. Build them before typecheck, Metro or Xcode: `pnpm -r build` (rebuild after editing them). Metro uses Expo's
  default pnpm-workspace detection; `node-linker` stays isolated.
- **`ios/` is generated (CNG) and not committed**: `expo prebuild` recreates it from `app.config.ts`.
- **Bundle id** comes from `PARLEY_MOBILE_BUNDLE_ID` (default `dev.example.parley.mobile`).
- **Variants.** `APP_VARIANT=dev` (default) adds `NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking` and the
  dev client. `APP_VARIANT=release` has none of them: the config removes what prebuild would add. The code also
  refuses `ws://` outside `__DEV__` (`relayUrlFor(r, { allowLocal: __DEV__ })`, and `createOpenSocket` checks again
  before a socket is constructed). ATS does not block `ws://` by itself; the release ban is in code.
- **Keychain** records use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. The Keychain survives deleting the app, so the
  first start without the install marker file calls `HostStore.wipeAll()` once and then writes the marker.
- **Tests** are vitest (pure TypeScript; adapters take their native modules as arguments, so no React Native runtime is needed).
- No `build` script in this package; `typecheck` is `tsc --noEmit`.

## Checks

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @parley/mobile typecheck
pnpm --filter @parley/mobile test
pnpm exec eslint packages/mobile
pnpm lint
```

## Simulator build and run

```sh
cd packages/mobile
APP_VARIANT=dev pnpm exec expo prebuild --platform ios --no-install
cd ios && pod install && cd ..
```

Build and install (any simulator id from `xcrun simctl list devices available`):

```sh
U=<simulator udid>
xcrun simctl boot $U && xcrun simctl bootstatus $U -b
xcodebuild -workspace ios/Parley.xcworkspace -scheme Parley -configuration Debug \
  -sdk iphonesimulator -destination "id=$U" -derivedDataPath /tmp/parley-derived \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=YES build
xcrun simctl install $U /tmp/parley-derived/Build/Products/Debug-iphonesimulator/Parley.app
```

**Sign ad hoc (`CODE_SIGN_IDENTITY="-"`, signing allowed).** With `CODE_SIGNING_ALLOWED=NO` the simulator binary has
no entitlements and every Keychain call fails with `A required entitlement is not present`.

Start Metro and open the app (no taps needed):

```sh
pnpm exec expo start --dev-client --localhost --port 8106 &
xcrun simctl spawn $U defaults write dev.example.parley.mobile EXDevMenuIsOnboardingFinished -bool YES
xcrun simctl launch $U dev.example.parley.mobile --initialUrl http://localhost:8106
```

`--initialUrl` is read by `expo-dev-launcher`. Do not use `simctl openurl`: it raises an "Open in app?" dialog that
only a tap dismisses. Port 8081 may be taken by another Metro; pick a free one. Restart Metro after editing source
when it runs with `CI=1`.

## Dev relay

Pairing arrives with A14. Until then the connection banner can be exercised against a local relay:

```sh
pnpm --filter @parley/relay dev      # prints ws://<LAN ip>:8787 (plain ws, in memory)
PARLEY_MOBILE_DEV_RELAY=<LAN ip>:8787 pnpm exec expo start --dev-client --localhost --port 8106
```

With `PARLEY_MOBILE_DEV_RELAY` (dev variant only) the app seeds one host record with random keys that points at that
relay (`src/dev/seed-host.ts`). The relay does not know the route, so the banner shows the relay's answer
("This Mac does not recognize this phone"); stop the relay to see the retry states. The seed cannot complete a handshake.

## Demo data (developer build)

Until pairing and a real Mac are in the loop, the A15 screens can be looked at with made-up data
(`src/dev/demo.ts`): add `PARLEY_MOBILE_DEV_DEMO=1` (and `PARLEY_MOBILE_DEV_RELAY=...` so a host exists) to the
`expo start` line. `PARLEY_MOBILE_DEV_ROUTE=works|work|session|question|plain` opens that screen once.
`PARLEY_MOBILE_DEV_APPROVE=1` lets Allow pass without the Face ID gate (A16 provides the real one; without a provider
approvals are refused). None of this exists in the release variant.

## Release variant

```sh
APP_VARIANT=release pnpm exec expo prebuild --platform ios --clean --no-install
grep -c "NSAllowsLocalNetworking\|NSLocalNetworkUsageDescription" ios/Parley/Info.plist   # 0
```

The release `Info.plist` must contain neither key and the app must not offer the dev client or `devRelay`.

## Network workaround (repo.reactnative.dev hangs)

`pod install` downloads RN prebuilt archives from `repo.reactnative.dev` (Cloudflare). On a network where the
transfer stalls, use Google's Maven Central mirror, keep the archives outside the repository and point CocoaPods at them:

```sh
A=$HOME/rn-artifacts/0.88.1
M=https://maven-central.storage-download.googleapis.com/maven2/com/facebook
mkdir -p $A && cd $A
for f in react/react-native-artifacts/0.88.1/react-native-artifacts-0.88.1-reactnative-core-debug.tar.gz \
         react/react-native-artifacts/0.88.1/react-native-artifacts-0.88.1-reactnative-dependencies-debug.tar.gz \
         hermes/hermes-ios/260318099.0.5/hermes-ios-260318099.0.5-hermes-ios-debug.tar.gz; do
  curl -fLO "$M/$f" && curl -fLO "$M/$f.sha256"
done
for f in *.tar.gz; do echo "$(cat $f.sha256)  $f"; done | shasum -a 256 -c

export RCT_TESTONLY_RNCORE_TARBALL_PATH=$A/react-native-artifacts-0.88.1-reactnative-core-debug.tar.gz
export RCT_USE_LOCAL_RN_DEP=$A/react-native-artifacts-0.88.1-reactnative-dependencies-debug.tar.gz
export HERMES_ENGINE_TARBALL_PATH=$A/hermes-ios-260318099.0.5-hermes-ios-debug.tar.gz
```

`export` them in the shell that runs `pod install`. On a network that reaches `repo.reactnative.dev`, skip all of this.

## iPhone (Personal Team)

Device steps (signing, Developer Mode, Local Network prompt, camera, Keychain wipe on reinstall) are in the A20
checklist of `docs/plans/2026-10-29-mobile-app-plan.md`. Personal Team cannot provision Push Notifications, so
`expo-notifications` is configured with `enableRemoteNotifications: false`.
