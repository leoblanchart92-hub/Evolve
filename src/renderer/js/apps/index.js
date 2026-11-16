/**
 * Evolve — Correspondance entre le type d'une application disponible
 * (data/apps.js) et la fonction qui construit le contenu de sa fenêtre.
 *
 * Une application sans type n'existe pas encore : elle n'a pas d'interface,
 * et aucune fenêtre factice ne lui en tient lieu.
 */

import { mountExplorer } from './explorer.js';

const MOUNTERS = Object.freeze({
  explorer: mountExplorer,
});

/**
 * @param {string} kind
 * @returns {((win: object, params: any, shell: object) => object|null) | null} `null` si aucune interface ne porte ce nom
 */
export function mounterFor(kind) {
  return Object.hasOwn(MOUNTERS, kind) ? MOUNTERS[kind] : null;
}
