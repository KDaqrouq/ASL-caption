import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** Bundles built by `npm run build`, one Vite run each (`--mode <entry>`). */
const ENTRIES: Record<string, string> = {
  content: 'AslMeetCaptions', // content script (isolated world)
  camera: 'AslCaptionsCamera', // camera frame (camera.html)
  'page-hook': 'AslCaptionsPageHook', // Meet's own world: captions in the outgoing video
};

/**
 * Content scripts cannot be ES modules and IIFE output cannot have several entries,
 * so each script is built separately. The default mode builds content.js and copies
 * public/; the other modes add their script to the same dist/.
 */
export default defineConfig(({ mode }) => {
  const entry = mode in ENTRIES ? mode : 'content';
  return {
    build: {
      outDir: 'dist',
      emptyOutDir: entry === 'content',
      copyPublicDir: entry === 'content',
      rollupOptions: {
        input: resolve(__dirname, `src/${entry === 'page-hook' ? 'pageHook' : entry}.ts`),
        output: {
          entryFileNames: `${entry}.js`,
          format: 'iife',
          name: ENTRIES[entry],
        },
      },
    },
    publicDir: 'public',
  };
});
