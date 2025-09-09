#!/usr/bin/env node
/**
 * optimize-images.js
 *
 * Usage examples:
 *   node optimize-images.js
 *   node optimize-images.js --src public --out public/opt --target 300 --maxWidth 1600
 *   node optimize-images.js --replace --delete-originals
 *
 * Flags:
 *   --src <dir>            Source directory (default: public)
 *   --out <dir>            Output directory (default: public/opt)  [ignored if --replace]
 *   --replace              Write .webp next to originals instead of /opt
 *   --delete-originals     (only with --replace) delete the original files after writing .webp
 *   --target <KB>          Target size per image in KB (default: 300)
 *   --maxWidth <px>        Max width to resize to (default: 1600)
 *   --minQ <0-100>         Min WebP quality for search (default: 65)
 *   --maxQ <0-100>         Max WebP quality for search (default: 95)
 *   --effort <0-6>         WebP encoder effort (default: 6)
 *   --downs <n>            Max downscale rounds if size can’t be reached (default: 4)
 *   --scaleStep <0-1>      Width multiplier per downscale round (default: 0.9)
 */

const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

function parseArgs() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.replace(/^--/, "");
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args.set(key, true);
      } else {
        args.set(key, next);
        i++;
      }
    }
  }
  return args;
}

const args = parseArgs();

const SRC_DIR = path.resolve(String(args.get("src") || "public"));
const REPLACE = !!args.get("replace");
const OUT_DIR = REPLACE
  ? SRC_DIR
  : path.resolve(String(args.get("out") || path.join(SRC_DIR, "opt")));
const DELETE_ORIG = !!args.get("delete-originals");

const TARGET_BYTES = Math.max(1, Number(args.get("target") || 300)) * 1024;
const MAX_WIDTH = Math.max(1, Number(args.get("maxWidth") || 1600));
const MIN_Q = Math.min(100, Math.max(0, Number(args.get("minQ") || 65)));
const MAX_Q = Math.min(100, Math.max(MIN_Q, Number(args.get("maxQ") || 95)));
const EFFORT = Math.min(6, Math.max(0, Number(args.get("effort") || 6)));
const MAX_DOWNSCALES = Math.max(0, Number(args.get("downs") || 4));
const SCALE_STEP = Math.min(0.99, Math.max(0.5, Number(args.get("scaleStep") || 0.9)));

const VALID_EXT = new Set([".png", ".jpg", ".jpeg"]); // you can include '.webp' if you want to recompress existing webp

function kb(n) {
  return (n / 1024).toFixed(1) + " KB";
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip output folder if inside src to avoid reprocessing
      if (path.resolve(p) === path.resolve(OUT_DIR)) continue;
      yield* walk(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

async function encodeWebPBuffer(inputPath, width, quality) {
  return sharp(inputPath)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality, effort: EFFORT })
    .toBuffer();
}

async function findBestEncode(inputPath, metaWidth) {
  // Start from max width but don’t enlarge
  let width = Math.min(metaWidth || MAX_WIDTH, MAX_WIDTH);
  let attempt = 0;
  let best = null;

  while (attempt <= MAX_DOWNSCALES) {
    // Binary search for quality in [MIN_Q, MAX_Q]
    let lo = MIN_Q, hi = MAX_Q;
    let bestLocal = null;

    while (lo <= hi) {
      const mid = Math.round((lo + hi) / 2);
      const buf = await encodeWebPBuffer(inputPath, width, mid);
      if (buf.length <= TARGET_BYTES) {
        bestLocal = { buf, width, quality: mid, bytes: buf.length };
        lo = mid + 1; // try higher quality within target
      } else {
        hi = mid - 1; // too big → lower quality
      }
    }

    if (bestLocal) {
      best = bestLocal;
      break; // success within target
    } else {
      // Couldn’t hit target even at MIN_Q → downscale width and retry
      const nextWidth = Math.max(320, Math.floor((width || MAX_WIDTH) * SCALE_STEP));
      if (nextWidth === width) break;
      width = nextWidth;
      attempt++;
    }
  }

  // If still nothing fits, produce “best effort” at MIN_Q / current width
  if (!best) {
    const buf = await encodeWebPBuffer(inputPath, Math.min(metaWidth || MAX_WIDTH, MAX_WIDTH), MIN_Q);
    best = {
      buf,
      width: Math.min(metaWidth || MAX_WIDTH, MAX_WIDTH),
      quality: MIN_Q,
      bytes: buf.length,
      bestEffort: true
    };
  }

  return best;
}

async function processOne(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!VALID_EXT.has(ext)) return null;

  const rel = path.relative(process.cwd(), filePath);
  const srcStat = await fs.stat(filePath).catch(() => null);
  const srcSize = srcStat ? srcStat.size : 0;

  let meta;
  try {
    meta = await sharp(filePath).metadata();
  } catch (e) {
    console.warn("⚠️  Skipping unreadable image:", rel, e.message);
    return null;
  }

  const base = path.basename(filePath, ext);
  const outPath = REPLACE
    ? path.join(path.dirname(filePath), `${base}.webp`)
    : path.join(OUT_DIR, path.relative(SRC_DIR, path.dirname(filePath)), `${base}.webp`);

  await ensureDir(path.dirname(outPath));

  const best = await findBestEncode(filePath, meta.width);
  await fs.writeFile(outPath, best.buf);

  if (REPLACE && DELETE_ORIG) {
    try { await fs.unlink(filePath); } catch {}
  }

  const verdict = best.bestEffort
    ? "best-effort"
    : (best.bytes <= TARGET_BYTES ? "✓" : "over");

  console.log(
    `${verdict.padEnd(10)} ${rel}  ->  ${path.relative(process.cwd(), outPath)}  ` +
    `[${kb(srcSize)} → ${kb(best.bytes)}]  width=${best.width}px  q=${best.quality}`
  );

  return { outPath, bytes: best.bytes, width: best.width, quality: best.quality };
}

async function main() {
  console.log(`\n🔧 Optimizing images\n  src: ${SRC_DIR}\n  out: ${REPLACE ? "(replace in place)" : OUT_DIR}\n  target: ${(TARGET_BYTES/1024).toFixed(0)} KB  maxWidth: ${MAX_WIDTH}px  q:[${MIN_Q}-${MAX_Q}] effort:${EFFORT}\n`);
  let count = 0;
  for await (const p of walk(SRC_DIR)) {
    if (VALID_EXT.has(path.extname(p).toLowerCase())) {
      try {
        await processOne(p);
        count++;
      } catch (e) {
        console.error("❌ Error:", p, e.message);
      }
    }
  }
  console.log(`\n✅ Done. Processed ${count} image(s).\n`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
