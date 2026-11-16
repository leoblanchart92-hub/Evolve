/**
 * Evolve — Recherche du menu Démarrer : applications, dossiers personnels et
 * paramètres rapides. Module pur (sans DOM), testé avec Node.
 *
 * Tout ce que la recherche propose existe : une application disponible se
 * lance, une application seulement annoncée est signalée comme telle, un
 * dossier personnel s'ouvre dans l'explorateur, un paramètre rapide ouvre son
 * panneau. Aucun fichier n'est cherché sur le disque, et aucun fichier fictif
 * n'est proposé.
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

/** Mots qui mènent aussi à un dossier personnel, par identifiant (voir PLACES, apps/explorer-nav.js). */
export const PLACE_KEYWORDS = Object.freeze({
  desktop: ['desktop'],
  documents: ['fichiers', 'textes', 'docs'],
  downloads: ['downloads', 'téléchargé'],
  pictures: ['photos', 'pictures'],
  music: ['audio', 'chansons', 'music'],
  videos: ['films', 'videos'],
});

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
 * Le premier résultat est le « meilleur résultat » — celui que la touche
 * Entrée ouvre : la meilleure correspondance parmi ce que l'on peut réellement
 * ouvrir, toutes sources confondues. Une application seulement annoncée n'est
 * en tête que si rien d'autre ne correspond. Les suivants sont regroupés par
 * type : applications (les disponibles d'abord), dossiers personnels,
 * paramètres.
 *
 * @param {string} query
 * @param {object} sources
 * @param {object[]} sources.apps  applications du registre (data/apps.js)
 * @param {{ id: string, name: string }[]} [sources.places]  dossiers personnels (apps/explorer-nav.js)
 * @param {(app: object) => boolean} [sources.isAvailable]  vrai pour une application que l'on peut lancer
 * @returns {{ type: 'app'|'place'|'setting', item: object, score: number, available: boolean }[]}
 */
export function search(query, { apps, places = [], isAvailable = () => true }) {
  if (!normalize(query)) return [];
  const results = [];

  const appMatches = rank(query, [...apps], (app) => app.name, (app) => app.keywords ?? []);
  const launchable = appMatches.filter(({ entry }) => isAvailable(entry));
  const upcoming = appMatches.filter(({ entry }) => !isAvailable(entry));
  for (const { entry, score } of [...launchable, ...upcoming].slice(0, 6)) {
    results.push({ type: 'app', item: entry, score, available: isAvailable(entry) });
  }

  const placeMatches = rank(query, [...places], (place) => place.name, (place) => PLACE_KEYWORDS[place.id] ?? []);
  for (const { entry, score } of placeMatches.slice(0, 6)) results.push({ type: 'place', item: entry, score, available: true });

  const settingMatches = rank(query, [...QUICK_SETTING_ENTRIES], (entry) => entry.label, (entry) => entry.keywords);
  for (const { entry, score } of settingMatches.slice(0, 4)) results.push({ type: 'setting', item: entry, score, available: true });

  // Le meilleur résultat passe en tête : d'abord ce que l'on peut ouvrir, puis la meilleure
  // correspondance ; à égalité, l'ordre des sources.
  let best = 0;
  const better = (a, b) => (a.available !== b.available ? a.available : a.score < b.score);
  results.forEach((result, index) => {
    if (better(result, results[best])) best = index;
  });
  if (best > 0) results.unshift(...results.splice(best, 1));
  return results;
}
