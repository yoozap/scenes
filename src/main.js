// Scene 1 is the whole page here, so unlike the landing this does not gate on
// viewport or pointer type — you opened a 3D scene, you get the 3D scene.
import { initCity } from './city.js'

initCity().catch((error) => {
  console.error('[scene] failed to start:', error)
  document.documentElement.classList.add('scene-failed')
})
