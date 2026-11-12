/**
 * Evolve — Icône d'un élément (dossier, fichier, lecteur, lien…), colorée par
 * un dégradé néon selon son type.
 */

import { describeNode } from '../core/file-types.js';
import { icon } from '../core/icons.js';

const TONE_GRADIENTS = Object.freeze({
  violet: 'grad-violet',
  magenta: 'grad-magenta',
  blue: 'grad-blue',
  cyan: 'grad-cyan',
  green: 'grad-green',
  amber: 'grad-amber',
  red: 'grad-red',
});

/**
 * @param {object} node  élément décrit par `kind`, `ext` et, au besoin, `icon` (core/file-types.js)
 * @param {{ class?: string, plain?: boolean }} [options]
 *        `plain` : pictogramme propre à l'emplacement (barre latérale, fil d'Ariane)
 *        plutôt que la forme « dossier ».
 * @returns {SVGSVGElement}
 */
export function nodeIcon(node, { class: className, plain = false } = {}) {
  const info = describeNode(node);
  const isFolder = node.kind === 'folder';
  const svg =
    isFolder && !plain
      ? icon('folder', 'fill', { class: className })
      : icon(info.icon, 'duotone', { class: className });
  svg.style.fill = `url(#${TONE_GRADIENTS[info.tone] ?? TONE_GRADIENTS.violet})`;
  return svg;
}
