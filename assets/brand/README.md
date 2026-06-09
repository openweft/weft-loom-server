# loom — brand assets

Visual identity for **loom**, the collaborative editor in the openweft family
(sibling of [weft](https://openweft.github.io)). Same weaving grammar as weft:
a 256-unit grid, `stroke-width: 22`, round caps — loom adds a second weft thread
so the mark reads as a woven `#`, **one thread per first-class language**.

## Concept

The editor *weaves* heterogeneous languages together. Each thread is a navy-cased
cord (navy casing + coloured core); at every crossing the thread on top is redrawn
so its navy edge follows the over/under — a true plain weave.

## Palette

| Role          | Hex       | Notes                                  |
|---------------|-----------|----------------------------------------|
| Casing / ink  | `#172445` | navy — weft's structural colour        |
| Rust          | `#CE412B` | warp                                   |
| Go            | `#00ADD8` | warp                                   |
| C++           | `#00599C` | weft                                   |
| LaTeX         | `#3FA535` | weft (no official colour — green)      |
| Tile (light)  | `#FACC15` | yellow — loom's product colour         |
| Tile (dark)   | `#FFFFFF` | white                                  |

## Files

| File                    | Use                                                        |
|-------------------------|------------------------------------------------------------|
| `loom-mark.svg`         | flat mark, transparent — parallels weft's `favicon.svg`    |
| `loom-mark-mono.svg`    | monochrome (`currentColor`, over/under via knockout gaps)  |
| `loom-wordmark.svg`     | mark + "loom" in Inter SemiBold, **outlined to paths**     |
| `loom-icon-white.svg`   | app icon, white tile (chosen for the server UI)            |
| `loom-icon-yellow.svg`  | app icon, yellow tile (alternative)                        |
| `favicon-{white,yellow}.ico` | multi-res `.ico` fallbacks (16/32/64)                 |
| `png/`                  | raster exports                                             |

App-icon tiles follow weft's `apple-touch-icon.svg` spec exactly: 180×180,
`rx=36` (20%), solid background, mark inside the ~80% HIG safe area
(`translate(18,18) scale(0.5625)`).

## Where it's wired

The running server serves icons from `web/public/` (Vite copies them to
`internal/web/dist/`, embedded via `//go:embed`):

- `web/public/favicon.svg`          → flat mark (browser tab)
- `web/public/apple-touch-icon.svg` → white tile (installed app)
- `web/public/site.webmanifest`     → PWA manifest (`theme_color #172445`)

## Regenerating

- Raster: `rsvg-convert -w <px> <svg> -o <png>`
- Wordmark outline: fontTools over Inter SemiBold (static TTF) — re-run if the
  word or weight changes (paths must stay font-independent).
- `.ico`: [`go-png2ico`](https://github.com/J-Siu/go-png2ico) — pure Go, CGO=0.
