/**
 * Evolve — Calculs de géométrie des fenêtres.
 * Fonctions pures (sans DOM) : testées directement avec Node.
 *
 * Un rectangle est { x, y, w, h } en pixels ; une zone est { w, h }.
 */

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Rectangle centré dans la zone de travail, avec un décalage « en cascade ».
 * La taille est réduite si la zone est trop petite.
 */
export function centeredRect(area, size, { margin = 0, offsetX = 0, offsetY = 0 } = {}) {
  const w = Math.max(0, Math.min(size.w, area.w - margin * 2));
  const h = Math.max(0, Math.min(size.h, area.h - margin * 2));
  const x = clamp((area.w - w) / 2 + offsetX, margin, Math.max(margin, area.w - w - margin));
  // Légèrement au-dessus du centre : plus agréable à l'œil.
  const y = clamp((area.h - h) * 0.42 + offsetY, margin, Math.max(margin, area.h - h - margin));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Limite la position d'une fenêtre pendant un déplacement :
 *  - le haut ne sort jamais de l'écran et la barre de titre reste au-dessus
 *    de la barre des tâches ;
 *  - une partie de la barre de titre reste toujours visible et saisissable :
 *    `keepLeft` pixels quand la fenêtre dépasse à gauche (zone plus large, car
 *    les boutons de fenêtre occupent l'extrémité droite du titre) et
 *    `keepRight` pixels quand elle dépasse à droite.
 */
export function clampWindowPosition({ x, y, w }, area, { keepLeft = 200, keepRight = 96, titlebar = 40 } = {}) {
  const minX = Math.min(keepLeft, w) - w;
  const maxX = Math.max(minX, area.w - Math.min(keepRight, w));
  return {
    x: clamp(x, minX, maxX),
    y: clamp(y, 0, Math.max(0, area.h - titlebar)),
  };
}

/**
 * Ramène un rectangle dans la zone de travail après un changement de
 * résolution : taille bornée à la zone, fenêtre replacée entièrement à l'écran.
 */
export function fitRectToArea(rect, area, { minW = 0, minH = 0 } = {}) {
  const w = clamp(rect.w, Math.min(minW, area.w), Math.max(area.w, 1));
  const h = clamp(rect.h, Math.min(minH, area.h), Math.max(area.h, 1));
  const x = clamp(rect.x, 0, Math.max(0, area.w - w));
  const y = clamp(rect.y, 0, Math.max(0, area.h - h));
  return { x, y, w, h };
}

/**
 * Disposition libre qu'une fenêtre retrouve en quittant l'agrandissement ou
 * l'ancrage : exactement celle que l'utilisateur lui avait donnée, même si
 * elle dépassait de l'écran. Seul ce qu'un déplacement à la souris ne
 * permettrait pas est corrigé : taille bornée à la zone de travail, barre de
 * titre ramenée à portée (voir clampWindowPosition).
 */
export function reachableRect(rect, area, { minW = 0, minH = 0, ...keep } = {}) {
  const w = clamp(rect.w, Math.min(minW, area.w), Math.max(area.w, 1));
  const h = clamp(rect.h, Math.min(minH, area.h), Math.max(area.h, 1));
  return { ...clampWindowPosition({ x: rect.x, y: rect.y, w }, area, keep), w, h };
}

/** Vrai pour un rectangle utilisable : quatre nombres finis, largeur et hauteur positives. */
export function isRect(rect) {
  return (
    Boolean(rect) &&
    ['x', 'y', 'w', 'h'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key])) &&
    rect.w > 0 &&
    rect.h > 0
  );
}

/**
 * Zone d'ancrage désignée par le pointeur pendant le déplacement d'une
 * fenêtre : le bord gauche ou droit de la zone de travail (la fenêtre en
 * occupera la moitié), ou le bord supérieur (elle sera agrandie). Dans un
 * coin, le côté l'emporte. `null` ailleurs — y compris au-dessus de la barre
 * des tâches, sous la zone de travail.
 * @param {{ x: number, y: number }} point  position du pointeur dans la zone de travail
 * @param {{ w: number, h: number }} area
 * @param {{ edge?: number }} [options]  épaisseur de la bande sensible, en pixels
 * @returns {'left'|'right'|'top'|null}
 */
export function snapZoneAt(point, area, { edge = 12 } = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (point.y > area.h || area.w <= 0 || area.h <= 0) return null;
  if (point.x <= edge) return 'left';
  if (point.x >= area.w - edge) return 'right';
  if (point.y <= edge) return 'top';
  return null;
}

/**
 * Rectangle d'une fenêtre ancrée : la moitié gauche ou la moitié droite de la
 * zone de travail, ou la zone entière (« top »). Les deux moitiés se
 * touchent sans se recouvrir, quelle que soit la largeur de la zone.
 * @returns {{ x: number, y: number, w: number, h: number } | null} `null` pour une zone inconnue
 */
export function snapRect(area, zone) {
  const half = Math.floor(area.w / 2);
  if (zone === 'left') return { x: 0, y: 0, w: half, h: area.h };
  if (zone === 'right') return { x: half, y: 0, w: area.w - half, h: area.h };
  if (zone === 'top') return { x: 0, y: 0, w: area.w, h: area.h };
  return null;
}

/**
 * Fenêtre « détachée » d'un état agrandi ou ancré par un glissement : elle
 * reprend sa taille libre, et sa barre de titre reste sous le pointeur, au
 * même endroit en proportion de sa largeur.
 * @param {{ x: number, y: number }} pointer  position du pointeur
 * @param {{ x: number, y: number, w: number, h: number }} from  rectangle occupé avant le glissement
 * @param {{ w: number, h: number }} size  taille libre retrouvée
 */
export function detachedRect(pointer, from, size) {
  const ratio = from.w > 0 ? clamp((pointer.x - from.x) / from.w, 0, 1) : 0.5;
  return { x: Math.round(pointer.x - size.w * ratio), y: Math.round(from.y), w: size.w, h: size.h };
}

/**
 * Rectangle d'une nouvelle fenêtre ouverte « en cascade » : décalée vers le
 * bas et la droite par rapport à la précédente. Si elle sortait de la zone de
 * travail, elle repart du coin supérieur gauche.
 * @param {{ x: number, y: number, w: number, h: number }} previous  fenêtre précédente (taille libre)
 * @param {{ w: number, h: number }} area
 * @param {{ stepX?: number, stepY?: number, margin?: number }} [options]
 */
export function cascadeRect(previous, area, { stepX = 28, stepY = 24, margin = 0 } = {}) {
  const w = Math.min(previous.w, Math.max(0, area.w - margin * 2));
  const h = Math.min(previous.h, Math.max(0, area.h - margin * 2));
  let x = previous.x + stepX;
  let y = previous.y + stepY;
  if (x + w > area.w - margin || x < margin) x = margin;
  if (y + h > area.h - margin || y < margin) y = margin;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Redimensionnement par une poignée : nouveau rectangle pour un déplacement
 * (`dx`, `dy`) du pointeur. La taille minimale est respectée, le bord
 * supérieur ne dépasse jamais le haut de l'écran, et le bord inférieur ne
 * descend pas sous la zone de travail (sauf si la fenêtre y était déjà).
 * @param {{ x: number, y: number, w: number, h: number }} start  rectangle au début du geste
 * @param {string} dir  poignée : « n », « e », « s », « w », « ne », « se », « sw », « nw »
 * @param {number} dx
 * @param {number} dy
 * @param {{ w: number, h: number }} area
 * @param {{ minW?: number, minH?: number }} [limits]
 */
export function resizedRect(start, dir, dx, dy, area, { minW = 0, minH = 0 } = {}) {
  let { x, y, w, h } = start;
  if (dir.includes('e')) w = Math.max(minW, start.w + dx);
  if (dir.includes('s')) h = clamp(start.h + dy, minH, Math.max(start.h, area.h - start.y, minH));
  if (dir.includes('w')) {
    w = Math.max(minW, start.w - dx);
    x = start.x + start.w - w;
  }
  if (dir.includes('n')) {
    h = clamp(start.h - dy, minH, Math.max(minH, start.y + start.h));
    y = start.y + start.h - h;
  }
  return { x, y, w, h };
}
