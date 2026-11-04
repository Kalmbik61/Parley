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
None of this exists in the release variant.

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

## Run on your iPhone over Wi-Fi

One command from the repository root builds the app for the phone, starts the relay on the Mac's LAN address, installs
and launches:

```sh
packages/mobile/scripts/device-run.sh            # --skip-build to reuse the last build, --udid <hardware UDID> for another phone
```

What it does: finds the Mac's LAN IPv4 and starts the dev relay on it (`ws://<IP>:8787`, or the next free port; printed); downloads the
**release** RN/Hermes archives from the Google mirror into `~/rn-artifacts/0.88.1` if missing (see "Network workaround");
runs `expo prebuild` and `pod install`; builds with `xcodebuild -sdk iphoneos`, signed with the Personal Team read from the
"Apple Development" certificate in the keychain (a bundle id `com.<mac user>.parley.mobile`; override with
`PARLEY_MOBILE_BUNDLE_ID`); installs and launches with `xcrun devicectl`. If the phone is not `connected` it stops after the
build and says so; connect and unlock the phone and run it again with `--skip-build`. The relay stays up until Ctrl-C.
The log files are in `$TMPDIR/parley-device-run/`.

**Why an embedded Release build, not a Debug dev client.** The build is the Release configuration of the **dev** variant: the JS
bundle is inside the app, so the phone needs no Metro (nothing to reach over the LAN, no dev-launcher screens, no cable after
the install), and Hermes is the optimised one, which A20 item 16 needs (Debug numbers are unusable). The dev variant keeps
the Local Network keys, and `extra.devBuild` (set only by the dev variant, never by the release variant) keeps `ws://` to a
private address allowed in that Release configuration (`DEV_BUILD` in `src/dev/build.ts`; Debug has `__DEV__`). The cost: a JS
change needs a rebuild (`--skip-build` does not rebuild); use the simulator with Metro for UI iterations. The release variant
and its refusal of `ws://` (A20 item 18, last clause) are checked with `APP_VARIANT=release` as in "Release variant" above.

The window is not driven by the script (the control socket needs the window's own token): the Relay field is typed by hand.

**Bench (A20 item 16).** Settings > Diagnostics > Crypto bench (dev builds only; absent in the release variant). It runs the S2
cases on `@parley/noise` (one side of an IK handshake, ChaCha20-Poly1305 64 KiB and 1 MiB encrypt/decrypt, x25519, SHA-256;
3 warm-up and 20 timed runs each), compares with the S7 thresholds (IK one side ≤ 150 ms, 64 KiB ≤ 50 ms) and shares the JSON.
The line on top must say `Release` and `Hermes`. Phone on the charger, Low Power Mode off, screen on; run twice, a minute apart.

**Voice loopback (B1).** Settings > Diagnostics > Voice loopback (dev builds only; absent in the release variant). Start asks for the
microphone, opens two in-process `RTCPeerConnection`s and plays the received track out of the loud speaker (`react-native-webrtc`;
`react-native-incall-manager` sets playAndRecord, voiceChat mode and the speaker route). Below it a pulsing orb (`react-native-svg` +
`react-native-reanimated` 4 on the UI thread) and a line in Golos Text (`expo-font`). B1 added native modules (WebRTC, incall-manager,
svg, reanimated, worklets), so a dev client or device build made before it must be rebuilt with `scripts/device-run.sh`.
Keep the volume low and say a few words: they come back about a quarter of a second later, without a squeal.

### What you do, in order

1. **Once:** Xcode > Settings > Accounts > add the Apple ID (the Mac already has the certificate "Apple Development:
   kalmbik61@gmail.com (45Q696H75T)"; Xcode needs the account to create the provisioning profile).
2. iPhone and Mac on the **same Wi-Fi** (not a guest network). Connect the iPhone by cable, unlock it, tap **Trust This
   Computer**. `xcrun devicectl list devices` must show it as `connected` (now it says `unavailable`).
3. **Developer Mode:** Settings > Privacy & Security > Developer Mode > on, restart the phone, confirm. If the switch is
   missing, run the script once (the install attempt makes it appear), then do this.
4. Run `packages/mobile/scripts/device-run.sh`. First build 10-20 minutes. macOS may ask whether `node` may accept incoming
   connections (the relay): **Allow**.
5. If launch says the developer is untrusted: iPhone Settings > General > VPN & Device Management > Developer App > your Apple
   ID > **Trust**, then open Parley from the home screen.
6. On the Mac, in the Parley window: Settings > **Remote access** on; Relay field = the address the script printed without
   `ws://` (`<IP>:8787`; the window marks it "Local dev relay, no TLS"); open **Pair a phone** to show the QR code and the SAS.
7. On the phone, Parley opens on the welcome screen: **Scan**, allow **Camera**, scan the QR; iOS asks for **Local
   Network**: **Allow** (the first connect fails if it is refused; Settings > Parley > Local Network). Compare the SAS words
   on both screens; **Confirm** in the window.
8. Then the run: Inbox, Allow with Face ID (allow **Face ID** when asked), New session, Bench (see above), and the A20 list.
   Reinstalling the app needs a new pairing (the Keychain is wiped on the first start after a reinstall).

The two things that can still block: the phone staying `unavailable` (cable, Trust, Developer Mode) and a missing Apple ID in
Xcode (`xcodebuild` then fails on provisioning; the script prints the matching hint).

## iPhone (Personal Team)

Device steps (signing, Developer Mode, Local Network prompt, camera, Keychain wipe on reinstall) are in the A20
checklist of `docs/plans/2026-10-29-mobile-app-plan.md`. Personal Team cannot provision Push Notifications, so
`expo-notifications` is configured with `enableRemoteNotifications: false`.
