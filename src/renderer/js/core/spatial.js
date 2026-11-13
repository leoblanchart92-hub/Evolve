/**
 * Evolve — Déplacement au clavier entre des éléments disposés à l'écran.
 *
 * Les flèches mènent à l'élément voisin dans la direction demandée : dans une
 * grille (icônes du bureau, tuiles du menu Démarrer) comme dans une simple
 * rangée (barre des tâches). Le voisin est choisi d'après la position réelle
 * des éléments, et non d'après leur ordre dans la page : la disposition peut
 * changer avec la taille de l'écran sans que ce module ait à le savoir.
 *
 * Module sans affichage (testé directement avec Node) : il ne reçoit que des
 * rectangles { left, top, width, height }.
 */

const DIRECTIONS = Object.freeze({
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
  up: { axis: 'y', sign: -1 },
  down: { axis: 'y', sign: 1 },
});

/** Direction désignée par une touche fléchée, ou `null`. */
export function arrowDirection(key) {
  return { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key] ?? null;
}

const centre = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/**
 * Rang, parmi `candidates`, du voisin de `origin` dans une direction.
 *
 * Un candidat n'est retenu que s'il se trouve réellement de ce côté. Parmi
 * ceux-là, l'élément de la même rangée (ou de la même colonne) est préféré au
 * plus proche en diagonale ; à égalité, le plus proche l'emporte.
 *
 * @param {{ left: number, top: number, width: number, height: number }} origin
 * @param {({ left: number, top: number, width: number, height: number } | null)[]} candidates
 * @param {'left'|'right'|'up'|'down'} direction
 * @returns {number} rang du voisin, ou -1 s'il n'y en a pas de ce côté
 */
export function neighbourIndex(origin, candidates, direction) {
  const move = DIRECTIONS[direction];
  if (!move || !origin) return -1;
  const from = centre(origin);
  const cross = move.axis === 'x' ? 'y' : 'x';
  // Tolérance : deux éléments « alignés » peuvent différer d'une fraction de pixel.
  const epsilon = 1;
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((rect, index) => {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
    const to = centre(rect);
    const along = (to[move.axis] - from[move.axis]) * move.sign;
    if (along <= epsilon) return; // pas de ce côté
    const aside = Math.abs(to[cross] - from[cross]);
    // Recouvrement sur l'axe transversal : l'élément est dans la même rangée ou la même colonne.
    const span = cross === 'y' ? [origin.top, origin.top + origin.height, rect.top, rect.top + rect.height] : [origin.left, origin.left + origin.width, rect.left, rect.left + rect.width];
    const aligned = Math.min(span[1], span[3]) - Math.max(span[0], span[2]) > epsilon;
    const score = along + aside * (aligned ? 0.5 : 4) + (aligned ? 0 : 10_000);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/**
 * Rang de l'élément à atteindre pour une touche de déplacement : une flèche
 * (voisin), « Home » (premier) ou « End » (dernier).
 * @param {string} key  touche pressée
 * @param {number} current  rang de l'élément courant (-1 : aucun)
 * @param {({ left: number, top: number, width: number, height: number } | null)[]} rects  rectangles des éléments, dans l'ordre
 * @returns {number} rang à atteindre, ou -1 si la touche ne déplace rien
 */
export function targetIndex(key, current, rects) {
  const usable = rects.map((rect, index) => (rect && rect.width > 0 && rect.height > 0 ? index : -1)).filter((index) => index >= 0);
  if (usable.length === 0) return -1;
  if (key === 'Home') return usable[0];
  if (key === 'End') return usable.at(-1);
  const direction = arrowDirection(key);
  if (!direction) return -1;
  // Aucun élément courant : la première flèche mène au premier élément.
  if (current < 0 || !rects[current]) return usable[0];
  return neighbourIndex(rects[current], rects.map((rect, index) => (index === current ? null : rect)), direction);
}
