# A35a: screens on an iOS 27.2 simulator (iPhone 17, own device `s195-ios27`)

Dev client + Metro with `PARLEY_MOBILE_DEV_DEMO=1` (made-up data, no lock), light and dark. The dev menu's floating button
is switched off (`EXDevMenuShowFloatingActionButton`), so the bar buttons are not covered.

| File | Screen |
|---|---|
| `works-*.png` | Works tab |
| `work-*.png` | Work screen: the ownerless room «тест» is a room container (`#`, mode chip, "2 agents · lead Редактор"); back "‹ Works" and "+" without capsules, accent tint |
| `room-*.png` | Room screen opened from it (`/room?…&room=r2`), "•••" without a capsule |
| `session-*.png` | Session screen, "•••" without a capsule |
| `settings-sub-*.png` | Settings → Diagnostics: "‹ Settings" without a capsule |

Edge-swipe back could not be driven on the simulator: Xcode 27's `simctl` has no touch injection and no Simulator.app window to
post pointer events to. It rests on the source of react-native-screens (`RNSScreenStack.mm`): the pop gesture's delegate is the
stack, which refuses it only when `gestureEnabled` is false (`_disableSwipeBack`); a hidden back button does not matter.
Needs one swipe on the phone.
