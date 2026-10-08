---
name: bench-api-docs
description: Document an exported bench-app function with the house JSDoc format. Use when adding or changing an exported function.
---

# bench-api-docs

Every exported function gets a JSDoc block right above it:

- first line: a one-sentence summary;
- `@since <version>`, the version from `package.json`;
- one `@throws {<code>} <when>` line per error code the function raises.
