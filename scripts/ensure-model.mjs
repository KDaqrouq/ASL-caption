// Prepares public/wasm/ before a build:
// - copies MediaPipe's vision WASM glue and binary from node_modules on every build, so they
//   always match the @mediapipe/tasks-vision version that Vite bundles;
// - downloads the hand landmarker and face detector models if they are missing.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'wasm');
const mpWasm = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];

const MODELS = {
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'blaze_face_short_range.tflite':
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
};

mkdirSync(outDir, { recursive: true });

if (!existsSync(mpWasm)) {
  console.error('Missing @mediapipe/tasks-vision; run `npm install` first.');
  process.exit(1);
}
for (const f of WASM_FILES) copyFileSync(join(mpWasm, f), join(outDir, f));

function download(src, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    get(src, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc || redirects === 0) return reject(new Error('Bad redirect'));
        return resolve(download(new URL(loc, src).toString(), dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${src}`));
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

for (const [name, url] of Object.entries(MODELS)) {
  const dest = join(outDir, name);
  if (existsSync(dest)) continue;
  // Download to a temporary name so an interrupted download is never mistaken for a model.
  const tmp = `${dest}.part`;
  try {
    await download(url, tmp);
    renameSync(tmp, dest);
    console.log(`Downloaded ${name} to public/wasm/`);
  } catch (e) {
    rmSync(tmp, { force: true });
    console.error(`Could not download ${name}: ${e.message}`);
    process.exit(1);
  }
}
