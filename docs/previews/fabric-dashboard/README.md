# Fabric dashboard preview evidence (fixture-labeled)

Exact-SHA renders of the user control panel Overview (Fabric flow topology +
throughput bench) for source revision
`c4974d4ad9fccea917956d08cd931f015042c861`.

- `AIPSTER_Fabric_desktop_1440x1000_full_c4974d4.png` (desktop 1440x1000, full page)
  SHA256 `e0d617e8e21ccf836445f65c7c89c60aa4e6cfbd5c11cd119fc0f04e4cea40e1`
- `AIPSTER_Fabric_mobile_390x844_full_c4974d4.png` (mobile 390x844, full page)
  SHA256 `c92f37a7718365b6611b2b36a4bdee569b89790f6c5638479a12327749c85478`

Provenance: single headless-browser session, desktop then mobile, against the
committed implementation served with clearly labeled synthetic fixtures
(demo session, stub read-only API — not the worker, not live data). No
horizontal overflow on either viewport; 0 console errors. Fixture preview
only: live-data qualification is not claimed.

Lineage: the prior `3e8e62f` image set is preserved separately as lane
evidence and was left untouched.
