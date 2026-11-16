/**
 * Evolve — Emplacement retenu des fenêtres.
 *
 * La position, la taille et l'agrandissement donnés en dernier à la fenêtre
 * de l'explorateur sont rangés dans l'état de l'interface (ui-state.js), que
 * le service des réglages conserve d'un lancement à l'autre (settings-sync.js).
 * La première fenêtre de l'explorateur rouverte les retrouve.
 *
 * Rien n'est retenu tant que l'utilisateur n'a ni déplacé, ni redimensionné,
 * ni agrandi une fenêtre : ouvrir puis fermer l'explorateur n'écrit rien.
 */

import { remPx } from '../core/dom.js';
import { decodePlacement, encodePlacement } from '../wm/placement.js';
import { ui } from './ui-state.js';

/** Clés de l'état de l'interface qui retiennent l'emplacement de la fenêtre d'une application. */
export const PLACEMENT_KEYS = Object.freeze({
  explorer: Object.freeze({
    x: 'explorerWindowX',
    y: 'explorerWindowY',
    w: 'explorerWindowWidth',
    h: 'explorerWindowHeight',
    maximized: 'explorerWindowMaximized',
  }),
});

/**
 * @param {object} [store]  état de l'interface (voir core/events.js)
 * @param {() => number} [unit]  taille actuelle d'un rem, en pixels
 * @returns {{ load: (appId: string) => ({ rect: object, maximized: boolean } | null),
 *             save: (appId: string, placement: { rect: object, maximized: boolean }) => void }}
 */
export function createWindowPlacement(store = ui, unit = remPx) {
  return {
    /** Emplacement retenu pour une application, en pixels, ou `null`. */
    load(appId) {
      const keys = PLACEMENT_KEYS[appId];
      if (!keys) return null;
      const rect = decodePlacement({ x: store.get(keys.x), y: store.get(keys.y), w: store.get(keys.w), h: store.get(keys.h) }, unit());
      return rect ? { rect, maximized: store.get(keys.maximized) === true } : null;
    },
    /** Retient l'emplacement d'une fenêtre de l'application. */
    save(appId, { rect, maximized }) {
      const keys = PLACEMENT_KEYS[appId];
      if (!keys) return;
      const values = encodePlacement(rect, unit());
      if (!values) return;
      store.set(keys.x, values.x);
      store.set(keys.y, values.y);
      store.set(keys.w, values.w);
      store.set(keys.h, values.h);
      store.set(keys.maximized, maximized === true);
    },
  };
}
