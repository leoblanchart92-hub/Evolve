/**
 * Evolve — Utilitaires de texte (purs, sans DOM).
 */

/** Normalise une chaîne pour la recherche : minuscules, sans accents. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
