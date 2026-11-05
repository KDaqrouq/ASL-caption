// Rebuilds every bundle (content.js, camera.js, page-hook.js) into dist/ on each change.
import { build } from 'vite';

for (const mode of ['content', 'camera', 'page-hook']) {
  await build({ mode, build: { watch: {}, emptyOutDir: false } });
}
