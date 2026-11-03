# A35d: session and room header palette (D1 §17.5)

iOS 27.2 simulator, demo data, light and dark. Each file has a prototype twin in `docs/design/2026-11-02-header-palette/`
(`session-needs-you-*`, `session-working-*`, `session-idle-*`, `room-*`). `works-tab-*` shows the tab bar tint (accent, not system blue).

Cause of the light bar in dark mode: `headerBlurEffect: 'systemChromeMaterial'` was fixed on iOS 26, where the system glass
follows the theme by itself; it is now unset on iOS 26+ and chosen by theme (`...Light` / `...Dark`) on iOS 17–25.
