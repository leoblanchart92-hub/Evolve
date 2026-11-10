/**
 * Evolve — Passerelle vers l'application de bureau.
 *
 * Dans l'exécutable Windows, le script de préchargement d'Electron expose un
 * petit objet `window.evolve` (quitter, plein écran). Dans un simple navigateur
 * (aperçu de développement), cet objet est absent et des solutions de repli
 * sont utilisées.
 */

const host = globalThis.evolve ?? null;

/** Vrai dans l'application de bureau (.exe), faux dans un navigateur. */
export const isDesktopApp = Boolean(host);

let fullscreen = false;
const fullscreenListeners = new Set();

function setFullscreen(value) {
  if (fullscreen === value) return;
  fullscreen = value;
  for (const fn of fullscreenListeners) fn(value);
}

if (host) {
  host.onFullscreenChange?.(setFullscreen);
  host.isFullscreen?.().then(setFullscreen, () => {});
} else if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => setFullscreen(Boolean(document.fullscreenElement)));
}

export const isFullscreen = () => fullscreen;

/** Bascule entre plein écran et mode fenêtré. Renvoie faux si c'est impossible. */
export async function toggleFullscreen() {
  try {
    if (host) {
      await host.toggleFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
    return true;
  } catch {
    return false;
  }
}

/** Ferme l'application. Renvoie faux dans un navigateur (action indisponible). */
export function quitApp() {
  if (!host) return false;
  host.quit();
  return true;
}
