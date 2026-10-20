# Icons

Kora's mark is its pixel sprite: the 12x12 creature from `apps/web/src/components/sprite/spriteData.ts` (classic body,
no accessory), near-white `#ededf0` with a `#a9abb3` shade and two dark eyes on a near-black tile.

Every bitmap here is generated. `scripts/brand/make-icons.py` (needs Pillow) carries the same ASCII map and scales it
nearest-neighbour by whole device pixels, so edges stay crisp at every size; a web test keeps the two maps in step.

```sh
python3 scripts/brand/make-icons.py
```

| Folder            | Used by                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icons/release/`  | the shipped app: `mac-1024.png` (1024 canvas, 824 px squircle with a soft shadow) becomes `icon.icns` in `scripts/package-app.sh`; `square-1024.png`, `windows.ico`, favicons, `apple-touch-180.png` |
| `icons/checkout/` | the app run from a source checkout (`pnpm start`, `pnpm dev`)                                                                                                                                        |
| `icons/kora-dev/` | the Kora Dev flavor (`pnpm app:install:dev`): the mark with a DEV tag                                                                                                                                |

The script also writes the web favicons into `apps/web/public`. The in-app logo (`KoraWordmark.tsx`) and the boot splash
(`apps/web/index.html`) are inline SVG.
