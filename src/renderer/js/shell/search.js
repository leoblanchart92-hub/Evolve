/**
 * Evolve — Recherche du menu Démarrer : applications, fichiers d'exemple et
 * paramètres rapides. Module pur (sans DOM), testé avec Node.
 */

import { normalize } from '../core/text.js';

/** Entrées « paramètres rapides » proposées par la recherche. */
export const QUICK_SETTING_ENTRIES = Object.freeze([
  { id: 'wifi', label: 'Wi-Fi', glyph: 'wifi-high', keywords: ['wifi', 'réseau', 'internet', 'sans fil'] },
  { id: 'bluetooth', label: 'Bluetooth', glyph: 'bluetooth', keywords: ['appareils', 'périphériques'] },
  { id: 'airplane', label: 'Mode avion', glyph: 'airplane-tilt', keywords: ['hors ligne'] },
  { id: 'brightness', label: 'Luminosité', glyph: 'sun', keywords: ['écran', 'affichage'] },
  { id: 'volume', label: 'Volume', glyph: 'speaker-high', keywords: ['son', 'audio', 'haut-parleur'] },
  { id: 'nightLight', label: 'Éclairage nocturne', glyph: 'moon', keywords: ['nuit', 'lumière bleue'] },
  { id: 'doNotDisturb', label: 'Ne pas déranger', glyph: 'bell-slash', keywords: ['notifications', 'silence'] },
  { id: 'energySaver', label: "Économie d'énergie", glyph: 'leaf', keywords: ['batterie', 'autonomie'] },
]);

/**
 * Score de correspondance : 0 = commence par la requête, 1 = un mot commence
 * par la requête, 2 = contient la requête, 3 = mot-clé ; -1 = aucune.
 */
export function matchScore(query, label, keywords = []) {
  const needle = normalize(query);
  if (!needle) return -1;
  const text = normalize(label);
  if (text.startsWith(needle)) return 0;
  if (text.split(/[\s'’-]+/).some((word) => word.startsWith(needle))) return 1;
  if (text.includes(needle)) return 2;
  if (keywords.some((keyword) => normalize(keyword).startsWith(needle))) return 3;
  return -1;
}

function rank(query, entries, getLabel, getKeywords = () => []) {
  return entries
    .map((entry) => ({ entry, score: matchScore(query, getLabel(entry), getKeywords(entry)) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score || getLabel(a.entry).localeCompare(getLabel(b.entry), 'fr'));
}

/**
 * Recherche dans toutes les sources.
 *
 * Le premier résultat est le « meilleur résultat » (meilleure correspondance,
 * toutes sources confondues) ; les suivants sont regroupés par type, dans
 * l'ordre applications → fichiers → paramètres.
 *
 * @param {string} query
 * @param {{ apps: object[], files: { search: (q: string, limit?: number) => object[] } }} sources
 * @returns {{ type: 'app'|'file'|'setting', item: object, score: number }[]}
 */
export function search(query, { apps, files }) {
  if (!normalize(query)) return [];
  const results = [];

  const appMatches = rank(query, [...apps], (app) => app.name, (app) => app.keywords ?? []);
  for (const { entry, score } of appMatches.slice(0, 6)) results.push({ type: 'app', item: entry, score });

  for (const node of files.search(query, 5)) {
    results.push({ type: 'file', item: node, score: Math.max(0, matchScore(query, node.name)) });
  }

  const settingMatches = rank(query, [...QUICK_SETTING_ENTRIES], (entry) => entry.label, (entry) => entry.keywords);
  for (const { entry, score } of settingMatches.slice(0, 4)) results.push({ type: 'setting', item: entry, score });

  // Le meilleur résultat passe en tête (à score égal, l'ordre des sources prime).
  let best = 0;
  results.forEach((result, index) => {
    if (result.score < results[best].score) best = index;
  });
  if (best > 0) results.unshift(...results.splice(best, 1));
  return results;
}
