---
name: bench-error-codes
description: Name and raise errors in bench-app. Use when adding code that can fail or throw.
---

# bench-error-codes

Raise `BenchError` from `src/errors.js` as `new BenchError(code, message)`.
Codes look like `E-<AREA>-<NNN>`: the area upper-case (`net` becomes `NET`), the number three digits.
The first code in an area is `001`; reuse one code for one failure kind.
