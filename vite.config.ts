import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Two classic-script bundles: the content script injected into Meet, and the camera
 * frame's script (camera.html). Content scripts cannot be ES modules and IIFE output
 * cannot have several entries, so `npm run build` runs Vite once per entry:
 * the default mode builds content.js, `--mode camera` adds camera.js.
 */
export default defineConfig(({ mode }) => {
  const entry = mode === 'camera' ? 'camera' : 'content';
  return {
    build: {
      outDir: 'dist',
      emptyOutDir: entry === 'content',
      copyPublicDir: entry === 'content',
      rollupOptions: {
        input: resolve(__dirname, `src/${entry}.ts`),
        output: {
          entryFileNames: `${entry}.js`,
          format: 'iife',
          name: entry === 'camera' ? 'AslCaptionsCamera' : 'AslMeetCaptions',
        },
      },
    },
    publicDir: 'public',
  };
});
