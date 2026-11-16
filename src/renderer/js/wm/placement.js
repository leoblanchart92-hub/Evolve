/**
 * Evolve — Emplacement retenu d'une fenêtre.
 *
 * La dernière position et la dernière taille données à la fenêtre d'une
 * application sont conservées d'un lancement à l'autre (voir
 * shell/settings-sync.js). Elles sont exprimées en centièmes de rem — l'unité
 * dans laquelle toute l'interface est dimensionnée — et non en pixels : une
 * fenêtre retrouve ainsi les mêmes proportions sur un écran d'une autre
 * définition.
 *
 * Module sans affichage (testé directement avec Node). Toute valeur relue est
 * contrôlée : un nombre absent, non entier ou hors bornes fait renoncer à
 * l'emplacement retenu, et la fenêtre s'ouvre alors à sa place habituelle.
 */

/** Bornes des valeurs conservées, en centièmes de rem (les mêmes que celles du service des réglages). */
export const PLACEMENT_LIMITS = Object.freeze({
  /** Position : une fenêtre peut dépasser de l'écran, à gauche notamment. */
  minPosition: -100_000,
  maxPosition: 100_000,
  /** Taille ; 0 signifie « aucun emplacement retenu ». */
  maxSize: 100_000,
});

const isInteger = (value) => typeof value === 'number' && Number.isInteger(value);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Valeurs à conserver pour un rectangle exprimé en pixels.
 * @param {{ x: number, y: number, w: number, h: number }} rect
 * @param {number} remPx  taille d'un rem, en pixels
 * @returns {{ x: number, y: number, w: number, h: number } | null} centièmes de rem, ou `null` si le rectangle est inutilisable
 */
export function encodePlacement(rect, remPx) {
  if (!rect || !(remPx > 0)) return null;
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every((value) => typeof value === 'number' && Number.isFinite(value)) || w <= 0 || h <= 0) return null;
  const units = (pixels) => Math.round((pixels / remPx) * 100);
  const { minPosition, maxPosition, maxSize } = PLACEMENT_LIMITS;
  return {
    x: clamp(units(x), minPosition, maxPosition),
    y: clamp(units(y), minPosition, maxPosition),
    w: clamp(units(w), 1, maxSize),
    h: clamp(units(h), 1, maxSize),
  };
}

/**
 * Rectangle en pixels correspondant à des valeurs conservées.
 * @param {{ x: any, y: any, w: any, h: any }} values  centièmes de rem
 * @param {number} remPx  taille d'un rem, en pixels
 * @returns {{ x: number, y: number, w: number, h: number } | null} `null` si aucun emplacement n'est retenu, ou s'il est invalide
 */
export function decodePlacement(values, remPx) {
  if (!values || !(remPx > 0)) return null;
  const { x, y, w, h } = values;
  const { minPosition, maxPosition, maxSize } = PLACEMENT_LIMITS;
  if (![x, y, w, h].every(isInteger)) return null;
  if (w <= 0 || h <= 0 || w > maxSize || h > maxSize) return null;
  if (x < minPosition || x > maxPosition || y < minPosition || y > maxPosition) return null;
  const pixels = (units) => Math.round((units * remPx) / 100);
  return { x: pixels(x), y: pixels(y), w: pixels(w), h: pixels(h) };
}
