# soundfonts 采样包许可

本目录的 `<palette>.json` 由 `scripts/vendor-soundfonts.mjs` 生成（从原始
gleitz 格式抽取、裁剪至 A1–C7 音域），许可链为双重 MIT：

- **采样本体 FluidR3_GM** — Copyright (c) 2000–2002, 2008 Frank Wen。
  MIT License（依据 Debian fluid-soundfont 打包记录）。
  注：gleitz README 将 Fluid 音源标注为 CC-BY 3.0——MIT 与 CC-BY 3.0 均
  仅要求署名，保留双署名即同时满足两种说法。
- **抽取/分发格式 gleitz/midi-js-soundfonts** — Copyright (c) 2012
  Benjamin Gleitzman（+ 文件内其余贡献者）。MIT License。
  源：https://github.com/gleitz/midi-js-soundfonts

调色板映射：piano=acoustic_grand_piano、strings=string_ensemble_1、
pad=pad_2_warm、bass=acoustic_bass、bell=music_box、choir=choir_aahs。
