#!/usr/bin/env node
/**
 * Evolve — Génération de la planche d'icônes de l'interface.
 *
 * Lit les pictogrammes nécessaires dans @phosphor-icons/core (licence MIT) et
 * écrit src/renderer/js/core/icons.data.js. Le fichier généré est versionné :
 * l'application n'a donc aucune dépendance à l'exécution et la compilation
 * n'a pas besoin de relancer ce script.
 *
 * Utilisation : npm run icons
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@phosphor-icons', 'core', 'assets');
const target = join(root, 'src', 'renderer', 'js', 'core', 'icons.data.js');

/** Graisses générées pour chaque pictogramme. */
const WEIGHTS = ['regular', 'fill', 'duotone'];

/** Pictogrammes utilisés par l'interface (noms Phosphor). */
const NAMES = [
  // Système et barre des tâches
  'magnifying-glass', 'bell', 'bell-slash', 'wifi-high', 'wifi-slash', 'bluetooth', 'bluetooth-slash',
  'speaker-high', 'speaker-low', 'speaker-none', 'speaker-x', 'battery-high', 'airplane-tilt', 'moon',
  'sun', 'sun-dim', 'leaf', 'power', 'user', 'sign-out', 'corners-out', 'corners-in', 'squares-four',
  'planet',
  // Navigation et actions
  'caret-left', 'caret-right', 'caret-up', 'caret-down', 'arrow-left', 'arrow-right', 'arrow-up',
  'arrow-clockwise', 'arrows-clockwise', 'x', 'check', 'plus', 'minus', 'info', 'question',
  'warning-circle', 'arrow-square-out', 'scissors', 'copy', 'clipboard-text', 'pencil-simple-line',
  'trash', 'arrows-down-up', 'list-bullets', 'link', 'lock', 'square-half',
  // Emplacements et matériel
  'house', 'desktop', 'download-simple', 'folder', 'folder-open', 'folder-plus', 'images',
  'music-notes', 'film-strip', 'hard-drive', 'network', 'cpu', 'memory', 'graphics-card', 'monitor',
  // Applications
  'gear-six', 'compass', 'terminal-window', 'storefront', 'envelope-simple', 'calendar-dots', 'image',
  'film-slate', 'note-pencil', 'calculator', 'cloud-sun', 'clock', 'camera', 'map-trifold',
  'game-controller', 'pulse', 'app-window',
  // Types de fichiers
  'file', 'file-text', 'file-doc', 'file-xls', 'file-ppt', 'file-pdf', 'file-image', 'file-audio',
  'file-video', 'file-zip', 'file-code',
];

function fileName(name, weight) {
  return weight === 'regular' ? `${name}.svg` : `${name}-${weight}.svg`;
}

/** Extrait le contenu interne d'un fichier SVG Phosphor. */
function innerMarkup(svg, file) {
  const match = svg.match(/^<svg[^>]*viewBox="0 0 256 256"[^>]*>(.*)<\/svg>\s*$/s);
  if (!match) throw new Error(`Format SVG inattendu : ${file}`);
  return match[1].trim();
}

const names = [...new Set(NAMES)].sort();
const symbols = [];

for (const name of names) {
  for (const weight of WEIGHTS) {
    const file = join(source, weight, fileName(name, weight));
    const svg = await readFile(file, 'utf8').catch(() => {
      throw new Error(`Pictogramme introuvable : ${name} (${weight})`);
    });
    symbols.push(`<symbol id="i-${name}-${weight}" viewBox="0 0 256 256">${innerMarkup(svg, file)}</symbol>`);
  }
}

const output = `/**
 * FICHIER GÉNÉRÉ — ne pas modifier à la main (voir scripts/build-icons.mjs).
 *
 * Pictogrammes issus de Phosphor Icons — https://phosphoricons.com
 * Copyright (c) 2023 Phosphor Icons — licence MIT (voir THIRD-PARTY-NOTICES.md).
 */

/** Noms des pictogrammes disponibles. */
export const ICON_NAMES = ${JSON.stringify(names)};

/** Graisses disponibles pour chaque pictogramme. */
export const ICON_WEIGHTS = ${JSON.stringify(WEIGHTS)};

/** Symboles SVG (injectés une seule fois dans le document). */
export const ICON_SYMBOLS = ${JSON.stringify(symbols.join(''))};
`;

await writeFile(target, output, 'utf8');
console.log(
  `Planche d'icônes générée : ${names.length} pictogrammes × ${WEIGHTS.length} graisses → ` +
    `${(Buffer.byteLength(output) / 1024).toFixed(0)} Ko (${target.replace(root, '.')})`,
);
