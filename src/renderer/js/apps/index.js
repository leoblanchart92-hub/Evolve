/**
 * Evolve — Correspondance entre le type d'une application (data/apps.js) et
 * la fonction qui construit le contenu de sa fenêtre.
 *
 * Une application dont le type est inconnu s'ouvre sans contenu plutôt qu'avec
 * une fenêtre d'attente : le registre (data/apps.js) ne déclare que des
 * applications réellement utilisables.
 */

import { mountExplorer } from './explorer.js';
import { mountSettings } from './settings.js';

const MOUNTERS = Object.freeze({
  explorer: mountExplorer,
  settings: mountSettings,
});

/**
 * @param {string} kind
 * @returns {((win: object, params: any, shell: object) => object|null)|null}
 */
export function mounterFor(kind) {
  return MOUNTERS[kind] ?? null;
}
