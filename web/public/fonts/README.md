# Vendored webfonts

Source: Google Fonts (`fonts.googleapis.com/css2`), fetched with a modern-Chrome UA
so each family arrives as unicode-range woff2 subsets (lazy per-subset loading is
preserved; the browser now fetches them from this local static server).

- Noto Serif SC 400/600/700 — body serif (SIL Open Font License 1.1, see OFL-noto-serif-sc.txt)
- Ma Shan Zheng 400 — display title font (SIL Open Font License 1.1, see OFL-ma-shan-zheng.txt)

（campus 侧另有 Sarasa Gothic SC 供监控台 DSL 渲染使用；main 无监控台，未收录。）

Fetched: 2026-09-17T08:12:56.480Z

Regenerate with `node scripts/vendor-webfonts.mjs`.
