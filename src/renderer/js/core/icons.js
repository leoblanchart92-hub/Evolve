/**
 * Evolve — Icônes de l'interface.
 *
 * Les pictogrammes sont des symboles SVG injectés une seule fois dans le
 * document ; chaque icône affichée n'est qu'une référence <use>, ce qui garde
 * le DOM léger et permet de les colorer avec `currentColor` ou un dégradé.
 */

import { ICON_NAMES, ICON_SYMBOLS, ICON_WEIGHTS } from './icons.data.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const KNOWN = new Set(ICON_NAMES);
const WEIGHTS = new Set(ICON_WEIGHTS);
const SPRITE_ID = 'evolve-icons';

/** Dégradés partagés : logo Evolve et icônes « néon » (dossiers, fichiers…). */
const GRADIENTS = `
  <radialGradient id="evolve-planet" cx="34%" cy="28%" r="78%">
    <stop offset="0" stop-color="#f7ebff"/>
    <stop offset="0.32" stop-color="#c9a0ff"/>
    <stop offset="0.66" stop-color="#9455ff"/>
    <stop offset="1" stop-color="#4c1d95"/>
  </radialGradient>
  <linearGradient id="evolve-ring" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#ffb3f4"/>
    <stop offset="0.5" stop-color="#d0a8ff"/>
    <stop offset="1" stop-color="#8e7bff"/>
  </linearGradient>
  <linearGradient id="grad-violet" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#e2c6ff"/>
    <stop offset="0.5" stop-color="#a974ff"/>
    <stop offset="1" stop-color="#7c3aed"/>
  </linearGradient>
  <linearGradient id="grad-magenta" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffc2f1"/>
    <stop offset="1" stop-color="#d946ef"/>
  </linearGradient>
  <linearGradient id="grad-blue" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b6d4ff"/>
    <stop offset="1" stop-color="#5b7cff"/>
  </linearGradient>
  <linearGradient id="grad-cyan" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b8f4ff"/>
    <stop offset="1" stop-color="#38bdf8"/>
  </linearGradient>
  <linearGradient id="grad-green" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b4ffd9"/>
    <stop offset="1" stop-color="#22c58b"/>
  </linearGradient>
  <linearGradient id="grad-amber" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffe6a8"/>
    <stop offset="1" stop-color="#ff9d3d"/>
  </linearGradient>
  <linearGradient id="grad-red" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffc0cf"/>
    <stop offset="1" stop-color="#ff4d7e"/>
  </linearGradient>
  <linearGradient id="grad-gauge" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ff9df0"/>
    <stop offset="0.5" stop-color="#b57bff"/>
    <stop offset="1" stop-color="#6f6bff"/>
  </linearGradient>
  <linearGradient id="grad-spark" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100">
    <stop offset="0" stop-color="#b57bff" stop-opacity="0.42"/>
    <stop offset="1" stop-color="#b57bff" stop-opacity="0"/>
  </linearGradient>
`;

/** Injecte (une seule fois) la planche de symboles et les dégradés. */
export function installIcons(doc = document) {
  if (doc.getElementById(SPRITE_ID)) return;
  const sprite = doc.createElementNS(SVG_NS, 'svg');
  sprite.id = SPRITE_ID;
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('width', '0');
  sprite.setAttribute('height', '0');
  // Pas de display:none : les dégradés référencés doivent rester actifs.
  sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  sprite.innerHTML = `<defs>${GRADIENTS}</defs>${ICON_SYMBOLS}`;
  doc.body.prepend(sprite);
}

function symbolId(name, weight) {
  let safeName = name;
  if (!KNOWN.has(name)) {
    console.error(`[icônes] pictogramme inconnu : « ${name} »`);
    safeName = 'question';
  }
  const safeWeight = WEIGHTS.has(weight) ? weight : 'regular';
  return `#i-${safeName}-${safeWeight}`;
}

/**
 * Crée une icône.
 * @param {string} name    nom du pictogramme (voir scripts/build-icons.mjs)
 * @param {'regular'|'fill'|'duotone'} [weight]
 * @param {{ class?: string, size?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, weight = 'regular', options = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', options.class ? `icon ${options.class}` : 'icon');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (options.size) svg.style.setProperty('--icon-size', options.size);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', symbolId(name, weight));
  svg.append(use);
  return svg;
}

/** Change le pictogramme d'une icône existante (ex. volume → muet). */
export function setIcon(svg, name, weight = 'regular') {
  const href = symbolId(name, weight);
  const use = svg.querySelector('use');
  if (use && use.getAttribute('href') !== href) use.setAttribute('href', href);
}

/** Indique si un pictogramme existe (utilisé par les tests). */
export const hasIcon = (name) => KNOWN.has(name);

/**
 * Logo Evolve : une planète et son anneau, clin d'œil au fond d'écran.
 * Dessiné en éléments séparés pour pouvoir animer l'anneau en CSS.
 * @returns {SVGSVGElement}
 */
export function logo(className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className ? `logo ${className}` : 'logo');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = LOGO_MARKUP;
  return svg;
}

export const LOGO_MARKUP = `
  <g class="logo__ring logo__ring--back" transform="rotate(-24 32 32)">
    <ellipse cx="32" cy="32" rx="27.5" ry="9.5" fill="none" stroke="url(#evolve-ring)" stroke-width="3.4" opacity="0.7"/>
  </g>
  <circle class="logo__planet" cx="32" cy="32" r="15.5" fill="url(#evolve-planet)"/>
  <g class="logo__ring logo__ring--front" transform="rotate(-24 32 32)">
    <path d="M4.5 32A27.5 9.5 0 0 0 59.5 32" fill="none" stroke="url(#evolve-ring)" stroke-width="3.4"/>
  </g>
`;
