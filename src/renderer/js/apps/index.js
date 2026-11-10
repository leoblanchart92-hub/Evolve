/**
 * Evolve — Correspondance entre le type d'une application (data/apps.js) et
 * la fonction qui construit le contenu de sa fenêtre.
 */

import { mountExplorer } from './explorer.js';
import { mountPlaceholder } from './placeholder.js';

const MOUNTERS = Object.freeze({
  explorer: mountExplorer,
  placeholder: mountPlaceholder,
});

/**
 * @param {string} kind
 * @returns {(win: object, params: any, shell: object) => object|null}
 */
export function mounterFor(kind) {
  return MOUNTERS[kind] ?? mountPlaceholder;
}
