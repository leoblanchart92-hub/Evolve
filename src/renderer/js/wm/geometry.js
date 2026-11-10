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
