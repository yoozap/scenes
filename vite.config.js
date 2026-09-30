import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The scenes, by the number that names them. Every page is built every time —
// they share one bundle, so carrying the other costs a few kB of HTML — but
// only one of them becomes the root.
const SCENES = {
  1: 'yoozap_scene_1.html',
  2: 'yoozap_scene_2.html',
}

// Each pod on usectl serves exactly ONE scene at its domain root, so SCENE
// picks which: `SCENE=2 npm run build` puts scene 2 at /. It defaults to 1,
// the scene that shipped first, so an unset environment builds what it
// always built. The chosen page is duplicated as index.html in the build
// output — the canonical per-scene filename keeps working alongside it. The
// dev server mirrors that: bare `/` rewrites to the same page, so localhost
// behaves like the deployed pod instead of 404ing at the root.
function sceneAsIndex(scene = process.env.SCENE ?? '1') {
  const page = SCENES[scene]
  if (!page) {
    throw new Error(
      `SCENE=${scene} is not a scene — expected one of ${Object.keys(SCENES).join(', ')}`,
    )
  }

  return {
    name: 'scene-as-index',
    closeBundle: () =>
      copyFile(
        resolve(import.meta.dirname, 'dist', page),
        resolve(import.meta.dirname, 'dist', 'index.html'),
        // no dist in a dev-server shutdown — only the build cares
      ).catch(() => {}),
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url.startsWith('/?')) {
          req.url = `/${page}${req.url.slice(1)}`
        }
        next()
      })
    },
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
      // No page is index.html, so name them explicitly or vite finds nothing.
      input: Object.fromEntries(
        Object.entries(SCENES).map(([n, page]) => [
          `scene${n}`,
          resolve(import.meta.dirname, page),
        ]),
      ),
    },
  },
})
