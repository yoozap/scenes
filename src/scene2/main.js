// Scene 2's entry. Scene 1 has its own in ../main.js; the two apps share the
// repo and the GLBs and nothing else.
import { initCity } from './city.js'

initCity().catch((error) => {
  console.error('[scene] failed to start:', error)
  document.documentElement.classList.add('scene-failed')
})
