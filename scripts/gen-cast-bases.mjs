// 批量生成新角色基准图与表情差分（参考树莓娘 calm.png 的画风与比例）。
//
// 管线与 output/image-gen/raspberry-diff 一致：
//   蓝幕整图 edit（input_fidelity=high, quality=high, 1152x1984）
//     → chroma key 纯蓝 + despill → 透明底立绘 PNG
//
// 用法：
//   npx tsx scripts/gen-cast-bases.mjs [--stage all|bases|diffs] [--only <castId>] [--force]
//   npx tsx scripts/gen-cast-bases.mjs --rekey-only [--only <castId>]   # 对已有 *_blue.png 重跑色键，不调 API
//
// 产出：output/image-gen/cast/<castId>/{base_blue,base,<diff>}.png
//       output/image-gen/cast/manifest.json
//       output/image-gen/cast/_contact_sheet.png
// 产出仅限内部使用，禁止提交/外传（output/ 已被 .gitignore 忽略）。
//
// Run: npx tsx scripts/gen-cast-bases.mjs
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { createImageClient } from "../src/tools/image-gen/client.js";
import { loadEnvConfig } from "../src/tools/image-gen/env.js";
import { loadImageFile } from "../src/tools/image-gen/files.js";

// ---------- 配置 ----------

const OUT_ROOT = "output/image-gen/cast";
const SIZE = "1152x1984";
const QUALITY = "high";
const REF_IMAGE = "output/image-gen/raspberry-diff/calm.png";

const BASE_PROMPT = `以这张参考图的画风为基准：日系动画赛璐璐立绘、干净均匀的深色细描边、柔和粉彩上色、大而明亮的眼睛，人物比例与参考图完全一致（约6.5头身的全身立绘）。
请绘制一个全新的角色，与参考图中的角色完全不同：
{DESC}
全身正面站姿立绘，双臂自然下垂微微张开，正视镜头，表情平静温和，头与脚完整入画，构图与参考图相同。
背景为纯蓝色幕布（RGB 0,0,255），完全均匀纯色，无渐变、无阴影、无文字、无杂物。`;

const DIFF_PROMPT = `保持图中角色的人物设计、发型、发饰、服装、姿势、构图、比例与绘画风格完全不变。
双臂必须保持与图中完全相同的自然下垂站姿：上臂贴住身体两侧、手肘不弯曲、双手手指自然放松并拢；
严禁张开手指、弯曲手肘、抬臂或做出任何手势，身体其余部分与图中完全一致。
仅修改面部表情与神态：{EXPR}
背景保持纯蓝色幕布（RGB 0,0,255）不变，完全均匀纯色，无渐变、无阴影、无杂物。`;

const EXPRESSIONS = [
  {
    id: "smile",
    prompt: "露出明朗开心的笑容，眼睛微微弯起，嘴角上扬，整体神态愉悦。",
  },
  {
    id: "surprised",
    prompt: "惊讶的神情：睁大眼睛、眉毛上挑、嘴巴微微张开，像是突然听到了意外的消息。",
  },
  {
    id: "embarrassed",
    prompt: "害羞窘迫的神态：脸颊明显泛红、视线稍微躲开镜头、嘴角抿紧，带着不好意思的样子。",
  },
  {
    id: "joyful",
    prompt: "开怀大笑：眼睛笑成弯弯的月牙（可以闭眼），嘴巴大大张开露出开朗的笑容，眉飞色舞，整体洋溢着藏不住的高兴。",
  },
  {
    id: "angry",
    prompt: "生气：眉头紧皱、瞪视镜头，嘴角用力下撇，脸颊微微鼓起，一脸明显的不高兴或恼火。",
  },
  {
    id: "thinking",
    prompt: "思考：视线从镜头移开、望向斜上方，眉头轻蹙、嘴巴轻抿，一副认真思索、拿不定主意的神态。",
  },
  {
    id: "smug",
    prompt: "得意：自信的微笑，只有一边嘴角上扬，下巴微微抬起，眼神带点骄傲和狡黠。",
  },
];

/** 角色阵容：2 女 2 男，服装配色均避开蓝色系（蓝幕色键安全）。 */
const CAST = [
  {
    id: "female_A",
    desc: "一位温柔娴静的女大学生学姐：亚麻棕色齐颈波波头短发，头侧别一枚奶白色发卡；杏色大眼睛；身穿米白色V领针织开衫，内搭白色翻领衬衫，下身是暗红色格纹百褶及膝裙、白色短袜和深棕色乐福鞋。",
  },
  {
    id: "female_B",
    desc: "一位活力四射的女高中生后辈：焦糖色低双马尾，扎着奶白色圆珠发饰；琥珀色大眼睛；身穿奶油色水手服上衣，配深绿色领结与深绿色百褶裙，白色过膝袜和棕色乐福鞋。",
  },
  {
    id: "male_A",
    desc: "一位开朗阳光的男高中生：栗色蓬松短碎发；茶色大眼睛；身穿白色短袖衬衫、外罩浅灰色V领针织背心，下身深灰色长裤和白色运动鞋。",
  },
  {
    id: "male_B",
    desc: "一位沉稳安静的男性学长：黑色清爽短发，戴银灰色细框眼镜；深灰色大眼睛；身穿燕麦色圆领针织毛衣、内搭白色衬衫并露出衣领，下身深炭灰色直筒长裤和深棕色皮鞋。",
  },
];

// ---------- 色键（纯蓝 chroma key + despill，边缘羽化） ----------

const BLUENESS_CANDIDATE = 60; // b − max(r,g) 达到该值才视为蓝幕候选
const B_MIN_CANDIDATE = 110; // 且 b 亮度下限（排除深色描边）
const EDGE_ALPHA_MAX = 20; // 边缘带 blueness ≤ 该值 → 完全不透明
const EDGE_ALPHA_MIN = 70; // 边缘带 blueness ≥ 该值 → 完全透明

/**
 * 去蓝幕：全局色键（blueness 阈值判定，树莓娘管线同款；角色服装配色已避开
 * 蓝色系，封闭蓝区如双腿间腿缝同样清除）；与蓝幕相邻的边缘带按 blueness
 * 线性羽化 alpha 并 despill（把溢出的蓝分量压回 max(r,g)）。
 * 返回 { png, removedRatio }。
 */
function chromaKeyBlue(bytes) {
  const image = PNG.sync.read(Buffer.from(bytes));
  const { width, height, data } = image;
  const total = width * height;
  const blueness = new Int16Array(total);
  const isBackground = new Uint8Array(total);
  let removed = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const bl = data[o + 2] - Math.max(data[o], data[o + 1]);
    blueness[i] = bl;
    if (bl >= BLUENESS_CANDIDATE && data[o + 2] >= B_MIN_CANDIDATE) {
      isBackground[i] = 1;
      removed += 1;
    }
  }

  for (let i = 0; i < total; i++) {
    if (isBackground[i] === 1) {
      data[i * 4 + 3] = 0;
      continue;
    }
    // 边缘带（与背景 4 邻接的非背景像素）：羽化 + despill
    const x = i % width;
    const y = (i - x) / width;
    const touchesBackground =
      (x > 0 && isBackground[i - 1] === 1) ||
      (x < width - 1 && isBackground[i + 1] === 1) ||
      (y > 0 && isBackground[i - width] === 1) ||
      (y < height - 1 && isBackground[i + width] === 1);
    if (!touchesBackground) continue;
    const o = i * 4;
    const bl = blueness[i];
    if (bl > EDGE_ALPHA_MAX) {
      const alpha = bl >= EDGE_ALPHA_MIN ? 0 : Math.round((255 * (EDGE_ALPHA_MIN - bl)) / (EDGE_ALPHA_MIN - EDGE_ALPHA_MAX));
      data[o + 3] = Math.min(data[o + 3], alpha);
    }
    const cap = Math.max(data[o], data[o + 1]);
    if (data[o + 2] > cap) data[o + 2] = cap;
  }

  return { png: PNG.sync.write(image), removedRatio: removed / total };
}

// ---------- 生成流程 ----------

function parseArgs(argv) {
  const args = { stage: "all", only: null, force: false, rekeyOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stage") args.stage = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--rekey-only") args.rekeyOnly = true;
  }
  if (!["all", "bases", "diffs"].includes(args.stage)) {
    console.error(`未知 stage: ${args.stage}（all|bases|diffs）`);
    process.exit(2);
  }
  return args;
}

/** 对已有 *_blue.png 重跑色键（调参用，不调 API）。 */
function rekeyExisting(dir, names, manifestItems) {
  for (const name of names) {
    const bluePath = path.join(dir, `${name}_blue.png`);
    const cutPath = path.join(dir, `${name}.png`);
    if (!fs.existsSync(bluePath)) continue;
    const keyed = chromaKeyBlue(fs.readFileSync(bluePath));
    fs.writeFileSync(cutPath, keyed.png);
    const existing = manifestItems.find((it) => it.name === name);
    if (existing) existing.removedRatio = Number(keyed.removedRatio.toFixed(4));
    console.log(`[rekey] ${name} removedRatio=${keyed.removedRatio.toFixed(4)}`);
  }
}

async function editToBlue(client, prompt, refImagePath) {
  const ref = await loadImageFile(refImagePath);
  const result = await client.edit({
    prompt,
    images: [ref],
    size: SIZE,
    quality: QUALITY,
    inputFidelity: "high",
    n: 1,
  });
  return result;
}

async function processOne({ client, name, prompt, refImagePath, bluePath, cutPath, force, manifestItems }) {
  const started = Date.now();
  if (fs.existsSync(cutPath) && !force) {
    console.log(`[skip] ${name}（已存在，--force 重生成）`);
    return;
  }
  const result = await editToBlue(client, prompt, refImagePath);
  const img = result.images[0];
  fs.writeFileSync(bluePath, img.bytes);

  const keyed = chromaKeyBlue(img.bytes);
  fs.writeFileSync(cutPath, keyed.png);

  const item = {
    name,
    blue: path.basename(bluePath),
    file: path.basename(cutPath),
    removedRatio: Number(keyed.removedRatio.toFixed(4)),
    bytes: keyed.png.byteLength,
    ms: Date.now() - started,
  };
  if (result.usage) item.usage = result.usage;
  manifestItems.push(item);
  console.log(
    `[ok] ${name} removedRatio=${item.removedRatio} ${(item.ms / 1000).toFixed(1)}s` +
      (result.usage && result.usage.totalTokens != null ? ` tokens=${result.usage.totalTokens}` : ""),
  );
  if (keyed.removedRatio < 0.2 || keyed.removedRatio > 0.95) {
    console.warn(`[warn] ${name} 透明占比 ${item.removedRatio} 异常，请人工检查`);
  }
}

/** contact sheet：每行一个角色（base + 各差分），透明区合成白底。 */
function buildContactSheet(castDirs, outPath) {
  const thumbW = 220;
  const gap = 12;
  const cols = 1 + EXPRESSIONS.length;
  const rows = castDirs.length;
  const thumbH = Math.round((thumbW * 1984) / 1152);
  const sheet = new PNG({
    width: cols * thumbW + (cols + 1) * gap,
    height: rows * thumbH + (rows + 1) * gap,
  });
  // 白底
  for (let i = 0; i < sheet.width * sheet.height; i++) {
    sheet.data[i * 4] = 255;
    sheet.data[i * 4 + 1] = 255;
    sheet.data[i * 4 + 2] = 255;
    sheet.data[i * 4 + 3] = 255;
  }
  const paste = (srcPng, dx, dy) => {
    const sw = Math.min(thumbW, srcPng.width);
    const sh = Math.min(thumbH, srcPng.height);
    for (let y = 0; y < sh; y++) {
      const sy = Math.floor((y * srcPng.height) / sh);
      for (let x = 0; x < sw; x++) {
        const sx = Math.floor((x * srcPng.width) / sw);
        const so = (sy * srcPng.width + sx) * 4;
        const a = srcPng.data[so + 3] / 255;
        const to = ((dy + y) * sheet.width + dx + x) * 4;
        for (let c = 0; c < 3; c++) {
          sheet.data[to + c] = Math.round(srcPng.data[so + c] * a + sheet.data[to + c] * (1 - a));
        }
      }
    }
  };
  castDirs.forEach((dir, row) => {
    const files = ["base.png", ...EXPRESSIONS.map((e) => `${e.id}.png`)];
    files.forEach((file, col) => {
      const fileFullPath = path.join(dir, file);
      if (!fs.existsSync(fileFullPath)) return;
      paste(PNG.sync.read(fs.readFileSync(fileFullPath)), gap + col * (thumbW + gap), gap + row * (thumbH + gap));
    });
  });
  fs.writeFileSync(outPath, PNG.sync.write(sheet));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnvConfig();
  const client = createImageClient({ apiKey: env.apiKey, baseUrl: env.baseUrl });

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const refPath = REF_IMAGE;
  if (!fs.existsSync(refPath)) {
    console.error(`参考图不存在: ${refPath}`);
    process.exit(2);
  }

  const cast = args.only ? CAST.filter((c) => c.id === args.only) : CAST;
  if (cast.length === 0) {
    console.error(`--only 未匹配角色: ${args.only}（可选: ${CAST.map((c) => c.id).join(", ")}）`);
    process.exit(2);
  }

  const manifestPath = path.join(OUT_ROOT, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : {
        generatedAt: new Date().toISOString(),
        base: `style ref: ${refPath}（仅画风/比例参考，角色全新）`,
        model: env.model ?? "gpt-image-2",
        size: SIZE,
        quality: QUALITY,
        pipeline: "蓝幕整图 edit（input_fidelity=high, quality=high, 1152x1984）→ 纯蓝色键 + despill",
        note: "产出仅限内部流通，禁止提交/外传（output/ 已被 .gitignore 忽略）",
        items: [],
        errors: [],
      };
  manifest.generatedAt = new Date().toISOString();

  let failures = 0;
  for (const character of cast) {
    const dir = path.join(OUT_ROOT, character.id);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n=== ${character.id} ===`);

    if (args.rekeyOnly) {
      rekeyExisting(dir, ["base", ...EXPRESSIONS.map((e) => e.id)], manifest.items);
      continue;
    }

    if (args.stage !== "diffs") {
      try {
        await processOne({
          client,
          name: `${character.id}/base`,
          prompt: BASE_PROMPT.replace("{DESC}", character.desc),
          refImagePath: refPath,
          bluePath: path.join(dir, "base_blue.png"),
          cutPath: path.join(dir, "base.png"),
          force: args.force,
          manifestItems: manifest.items,
        });
      } catch (error) {
        failures += 1;
        manifest.errors.push({ name: `${character.id}/base`, error: String(error?.message ?? error) });
        console.error(`[fail] ${character.id}/base:`, error?.message ?? error);
      }
    }

    if (args.stage !== "bases") {
      const bluePath = path.join(dir, "base_blue.png");
      if (!fs.existsSync(bluePath)) {
        failures += 1;
        console.error(`[fail] ${character.id} 缺少 base_blue.png，先跑 --stage bases`);
        continue;
      }
      for (const expr of EXPRESSIONS) {
        try {
          await processOne({
            client,
            name: `${character.id}/${expr.id}`,
            prompt: DIFF_PROMPT.replace("{EXPR}", expr.prompt),
            refImagePath: bluePath,
            bluePath: path.join(dir, `${expr.id}_blue.png`),
            cutPath: path.join(dir, `${expr.id}.png`),
            force: args.force,
            manifestItems: manifest.items,
          });
        } catch (error) {
          failures += 1;
          manifest.errors.push({ name: `${character.id}/${expr.id}`, error: String(error?.message ?? error) });
          console.error(`[fail] ${character.id}/${expr.id}:`, error?.message ?? error);
        }
      }
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  buildContactSheet(
    cast.map((c) => path.join(OUT_ROOT, c.id)),
    path.join(OUT_ROOT, "_contact_sheet.png"),
  );

  const totalTokens = manifest.items.reduce((sum, it) => sum + (it.usage?.total_tokens ?? 0), 0);
  console.log(`\n完成：${manifest.items.length} 张，累计 tokens=${totalTokens}，失败=${failures}`);
  console.log(`manifest → ${manifestPath}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
