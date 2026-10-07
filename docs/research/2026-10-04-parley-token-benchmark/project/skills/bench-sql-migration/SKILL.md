---
name: bench-sql-migration
description: Write a reversible SQL migration for bench-app. Use when asked to change the database schema.
---

# bench-sql-migration

One file per change, named `NNNN_<what>.sql`, with an `-- up` and a `-- down` section.
