// Rebuilds both bundles (content.js and camera.js) into dist/ on every change.
import { build } from 'vite';

for (const mode of ['production', 'camera']) {
  await build({ mode, build: { watch: {}, emptyOutDir: false } });
}
