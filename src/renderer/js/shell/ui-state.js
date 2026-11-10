/**
 * Evolve — État visuel partagé de l'environnement.
 *
 * Ces valeurs ne pilotent QUE l'interface (icônes, panneaux, effets d'écran).
 * Aucun paramètre de Windows n'est lu ni modifié.
 */

import { createStore } from '../core/events.js';

export const ui = createStore({
  // Paramètres rapides (visuels)
  wifi: true,
  bluetooth: true,
  airplane: false,
  energySaver: false,
  nightLight: false,
  doNotDisturb: false,
  brightness: 100,
  volume: 64,
  muted: false,

  // Bureau
  widgetsVisible: true,
  desktopIconsVisible: true,

  // Notifications non lues (pastille de la barre des tâches)
  notificationCount: 0,
});

/** Pictogramme du volume selon le niveau. */
export function volumeGlyph(volume, muted) {
  if (muted || volume <= 0) return 'speaker-x';
  if (volume < 34) return 'speaker-none';
  if (volume < 67) return 'speaker-low';
  return 'speaker-high';
}

/** Pictogramme du réseau selon l'état. */
export function networkGlyph({ wifi, airplane }) {
  if (airplane) return 'airplane-tilt';
  return wifi ? 'wifi-high' : 'wifi-slash';
}
