# Static export receipt — synthetic two-user federation demo

- Source SHA (reviewed demo files): 5fee28ea307f95fa587048452cd1312fff59e18a
- Render command (repo root): `node website/demo/federation-two-user/render-export.mjs`
- Export file: `website/demo/federation-two-user/export/EXPORT_federation-two-user.html`
- Byte count (UTF-8): 4426
- SHA-256 of export HTML: 37deb56fa1714d5e5a987e19b0b019239d976ef67d267ddb713c9aba232f8216
- Reproducibility: the export is byte-stable — random grant/approval ids are
  rendered as `<id>` placeholders and the audit list as per-path counts, so
  re-rendering yields this same byte count and SHA-256.
- No-network confirmation: in-process Request dispatch only; this script
  performs no fetch, no listen, serves no URL, launches no browser.
- Labeling: every demo value labeled SYNTHETIC/FIXTURE; NOT SHOWN LIVE
  panel preserved in the export with reasons + live-test prerequisites.
- Rollback: delete `website/demo/federation-two-user/export/`.
