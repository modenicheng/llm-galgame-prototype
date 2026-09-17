# Vendored webfonts

Source: Google Fonts (`fonts.googleapis.com/css2`), fetched with a modern-Chrome UA
so each family arrives as unicode-range woff2 subsets (lazy per-subset loading is
preserved; the browser now fetches them from this local static server).

- Noto Serif SC 400/600/700 — body serif (SIL Open Font License 1.1, see OFL-noto-serif-sc.txt)
- Ma Shan Zheng 400 — display title font (SIL Open Font License 1.1, see OFL-ma-shan-zheng.txt)
- Sarasa Gothic SC (更纱黑体) 400/700 — monitor dashboard monospace (DSL
  rendering, logs, pre blocks). SIL OFL 1.1, see OFL-sarasa-gothic-sc.txt.
  Copied verbatim from the local system install (`C:\Windows\Fonts`,
  ~24MB/weight, no subsetting — the Terminal variant is not installed, so
  the Gothic SC files are vendored). Registered in `sarasa.css`, which
  `scripts/vendor-webfonts.mjs` does NOT regenerate.

Fetched: 2026-09-17T08:12:56.480Z

Regenerate with `node scripts/vendor-webfonts.mjs`.
