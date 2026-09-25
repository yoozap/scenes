import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Each pod on usectl serves exactly ONE scene at its domain root, so the
// scene's page is duplicated as index.html in the build output — the
// canonical per-scene filename keeps working alongside it.
function sceneAsIndex(page = 'yoozap_scene_1.html') {
  return {
    name: 'scene-as-index',
    apply: 'build',
    closeBundle: () =>
      copyFile(
        resolve(import.meta.dirname, 'dist', page),
        resolve(import.meta.dirname, 'dist', 'index.html'),
      ),
  }
}

// three's DRACOLoader resolves its decoder at module scope with
// `new URL('../libs/draco/…', import.meta.url).toString()` — five constants in
// all. Vite's asset-import-meta-url transform emits a hashed copy of every
// file named that way, before tree-shaking and whether or not the constant is
// ever read, so the build carried 1.3 MB of decoder the browser never asks
// for: city.js points the loader at public/draco/ instead. Rewriting the
// constants to literals removes the emit and makes the defaults agree with
// what the scene actually fetches.
function dracoDecoderPath(base = '/draco/') {
  return {
    name: 'draco-decoder-path',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('three/examples/jsm/loaders/DRACOLoader.js')) return null
      const out = code.replace(
        /new URL\(\s*'\.\.\/libs\/draco\/(?:gltf\/)?([\w.]+)'\s*,\s*import\.meta\.url\s*\)\.toString\(\)/g,
        (_, file) => JSON.stringify(base + file),
      )
      if (out === code) {
        this.warn('DRACOLoader decoder URLs did not match — three may have changed; check the emitted assets')
      }
      return { code: out, map: null }
    },
  }
}

export default defineConfig({
  plugins: [dracoDecoderPath(), sceneAsIndex()],
  build: {
    rollupOptions: {
      // The page is not index.html, so name it explicitly or vite finds nothing.
      input: { scene1: resolve(import.meta.dirname, 'yoozap_scene_1.html') },
    },
  },
})
