# Viewport evidence — landing page (no repair needed)

Live build `d1de902` (site revision `2026-10-29.2`), measured 2026-10-31 in
real Chrome via CDP after fonts loaded and full-page lazy traversal.

## Result: no horizontal overflow at any tested width

| Viewport | innerWidth | document scrollWidth | Offenders | JS errors |
|---|---|---|---|---|
| 320 mobile emulation | 320 | 320 | 0 | 0 |
| 390 mobile emulation | 390 | 390 | 0 | 0 |
| 504 desktop window | 504 | 489 (= clientWidth; scrollbar) | 0 | 0 |
| 768 | 768 | 753 (= clientWidth; scrollbar) | 0 | 0 |
| 1440 | 1440 | 1425 (= clientWidth; scrollbar) | 0 | 0 |

Diagrams scale correctly at every width (intrinsic 2000/2200px images render
fitted, e.g. 332px at 390px, 1146px at 1440px) and keep working full-size SVG
links (`/assets/*.svg`). Sign-in entry points at `/app/`; `/app` title and
back-navigation verified. Real keyboard Tab matches `:focus-visible` with a
visible 3px outline, focused link in view, no layout shift.

## The 3244 reading was a pre-stylesheet transient, not a bug

An early report cited `scrollWidth` 3244 at a 390px viewport. Re-measurement
shows that value only before the stylesheet applies (0 stylesheets loaded):
unstyled intrinsic image widths (sponsor art 3236px, diagrams 2000/2200px)
with the emulation not yet effective (`innerWidth` 1560 pre-commit). Once CSS
applies (`img{max-width:100%}` plus the 390/760/1000 media queries), every
width settles to zero overflow. No CSS or markup change was made; none is
warranted. Method note: viewports below Chrome's minimum window width must be
measured with device emulation, not a resized window.
