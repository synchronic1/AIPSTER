<!-- Built with Meta Muse. -->
# AIPSTER worker tray icon

An original mark drawn for the worker; it does not copy any vendor or emoji
art. Geometry: a near-black rounded tile (`#0b0e12`) carrying a bold geometric
peach (`#f2b887`) "A" — apex top-center, legs to the bottom corners, crossbar
at 62% height — with a status dot at bottom-right separated by a dark ring:

| Asset | Dot | Meaning |
|---|---|---|
| `tray-ok.ico` | green `#98c379` | worker process running locally |
| `tray-warn.ico` | red `#e06c75` | error (port conflict, crash loop) |
| `tray-off.ico` | gray `#6b7280` | worker stopped |

The dot reports the **local worker process only**. It never claims pairing,
connection, or inference readiness, which do not exist yet.

## Source and regeneration

`icon.py` is the editable source (stdlib only, no Pillow): it rasterizes the
geometry at 16/20/24/32/40/48/64 px, bundles PNG-compressed ICO entries
(Windows Vista+), and emits the `tray.svg` vector master with identical
geometry. To change the mark, edit the geometry in `icon.py` and rerun:

```powershell
cd local-worker
python packaging/icon/icon.py
```

`previews/` holds inspection renders (gitignored); check 16x16 legibility
after any change. The ICOs ship in the installed `icons/` directory and are
loaded per state at runtime; the main application/database icon uses
`tray-ok.ico`.
