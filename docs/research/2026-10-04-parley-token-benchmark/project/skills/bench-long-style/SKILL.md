---
name: bench-long-style
description: Record and id conventions for bench-app domain records (long reference with appendices). Use when adding a function that creates a domain record such as an invoice, order or customer.
---

# bench-long-style

Long reference for domain records. Read the whole file before writing code: the rules are
spread across sections and the appendices only repeat them in detail.

## Section 1: order records

Records of kind `order` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `order` records are kept in the appendix below.

Appendix 1. When a `order` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 2: customer records

Records of kind `customer` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `customer` records are kept in the appendix below.

Appendix 2. When a `customer` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 3: shipment records

Records of kind `shipment` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `shipment` records are kept in the appendix below.

Appendix 3. When a `shipment` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 4: refund records

Records of kind `refund` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `refund` records are kept in the appendix below.

Appendix 4. When a `refund` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 5: coupon records

Records of kind `coupon` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `coupon` records are kept in the appendix below.

Appendix 5. When a `coupon` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 6: ledger records

Records of kind `ledger` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `ledger` records are kept in the appendix below.

Appendix 6. When a `ledger` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 7: audit records

Records of kind `audit` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `audit` records are kept in the appendix below.

Appendix 7. When a `audit` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 8: session records

Records of kind `session` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `session` records are kept in the appendix below.

Appendix 8. When a `session` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 9: device records

Records of kind `device` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `device` records are kept in the appendix below.

Appendix 9. When a `device` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 10: invoice records

Records of kind `invoice` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `invoice` records are kept in the appendix below.

Appendix 10. When a `invoice` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 11: order records

Records of kind `order` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `order` records are kept in the appendix below.

Appendix 11. When a `order` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 12: customer records

Records of kind `customer` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `customer` records are kept in the appendix below.

Appendix 12. When a `customer` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 13: shipment records

Records of kind `shipment` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `shipment` records are kept in the appendix below.

Appendix 13. When a `shipment` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 14: refund records

Records of kind `refund` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `refund` records are kept in the appendix below.

Appendix 14. When a `refund` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 15: coupon records

Records of kind `coupon` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `coupon` records are kept in the appendix below.

Appendix 15. When a `coupon` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 16: ledger records

Records of kind `ledger` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `ledger` records are kept in the appendix below.

Appendix 16. When a `ledger` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 17: audit records

Records of kind `audit` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `audit` records are kept in the appendix below.

Appendix 17. When a `audit` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 18: session records

Records of kind `session` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `session` records are kept in the appendix below.

Appendix 18. When a `session` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 19: device records

Records of kind `device` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `device` records are kept in the appendix below.

Appendix 19. When a `device` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 20: invoice records

Records of kind `invoice` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `invoice` records are kept in the appendix below.

Appendix 20. When a `invoice` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 21: order records

Records of kind `order` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `order` records are kept in the appendix below.

Appendix 21. When a `order` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 22: customer records

Records of kind `customer` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `customer` records are kept in the appendix below.

Appendix 22. When a `customer` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 23: shipment records

Records of kind `shipment` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `shipment` records are kept in the appendix below.

Appendix 23. When a `shipment` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Section 24: refund records

Records of kind `refund` are created in `src/records.js` next to the other factories. A factory takes the
fields of the record and returns a plain object; it never mutates its input and never reads global state.
Timestamps are ISO 8601 in UTC, amounts are integers in the smallest currency unit, and optional fields are
omitted rather than set to `null`. Review notes for `refund` records are kept in the appendix below.

Appendix 24. When a `refund` factory grows beyond twenty lines, split the validation into a helper in the
same file and cover each branch with a test. Keep field names in camelCase and avoid abbreviations except for
`id` and `url`. Do not add fields that no caller reads yet; a record only carries what its consumers use.

## Final rule: record ids

Every new record id is built as `bnch_<kind-prefix>_<number>`. The prefix for invoices is `inv`, for orders `ord`,
for customers `cus`. The number is a positive integer counter, not a random value. This rule overrides the
older `<kind>-<seq>` ids that `makeRecord` still returns.
