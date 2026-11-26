# Two interface languages

## Settings and startup

In the desktop interface language selector, offer only English and Russian, using their existing native labels. Default new profiles to English. Keep explicit choices across full launches. Remove the system option and its label from the interface-language catalog. Keep the existing restart behavior.

## Existing profiles

For an existing desktop settings object with the previous `system` setting or no locale field, resolve its old effective language once on desktop startup using the preferred system language. Store that result as `en` or `ru` through the existing serialized, atomic UI store. Preserve other settings and explicit choices. A changed OS language on a later launch must not change the migrated preference. A missing file is a new profile. Read-only CLI, export, and host readers should agree on the default and continue to interpret legacy profiles until the desktop migrates them.

## Implementation and acceptance

1. Update the core locale options, desktop settings UI, UI store/startup, and the locale readers that share this preference. Limit changes to the interface language.
2. Test both selector options, English on a fresh profile even on a Russian system, choice persistence, and a legacy system preference on Russian and unsupported systems. Check that migration preserves unrelated settings and a later change in the system language cannot change the migrated selection.
3. Run focused core, host and desktop tests, type checks for changed packages and the desktop locale restart scenario.
