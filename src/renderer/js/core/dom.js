/**
 * Evolve — Petits utilitaires DOM (aucune dépendance).
 */

import { normalize } from './text.js';

/**
 * Crée un élément.
 * @param {string} tag
 * @param {Record<string, any>|null} [props]  class, dataset, style (objet), text,
 *        on<Événement> (fonction) ou tout attribut HTML.
 * @param  {...(Node|string|null|undefined|false|Array)} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') {
        node.className = value;
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key === 'style' && typeof value === 'object') {
        setStyles(node, value);
      } else if (key === 'text') {
        node.textContent = value;
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  append(node, children);
  return node;
}

/** Ajoute des enfants (nœuds, chaînes, tableaux imbriqués ; ignore null/false). */
export function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.append(child);
  }
  return parent;
}

/** Applique un objet de styles ; gère les propriétés personnalisées (--x). */
export function setStyles(node, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    if (prop.startsWith('--')) node.style.setProperty(prop, value);
    else node.style[prop] = value;
  }
}

/** Vide un élément et y place de nouveaux enfants. */
export function replaceChildren(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Taille actuelle d'un rem en pixels (l'interface est dimensionnée en rem). */
export function remPx() {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** Convertit des rem en pixels. */
export const rem = (n) => n * remPx();

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Vrai si l'utilisateur a demandé à réduire les animations. */
export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Marge accordée à une animation au-delà de sa durée prévue. */
const ANIMATION_GRACE_MS = 400;
const EXPIRED = Symbol('expired');

/**
 * Lance une animation (Web Animations API) et attend sa fin.
 * Ne rejette jamais : une animation annulée se résout simplement.
 *
 * L'attente est bornée : quand la fenêtre n'est pas dessinée (réduite, masquée),
 * le moteur suspend les animations ; l'interface ne doit pas rester en suspens
 * pour autant (une fenêtre fermée doit disparaître, etc.).
 */
export async function animate(node, keyframes, options = {}) {
  if (typeof node.animate !== 'function') return;
  const opts = { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'none', ...options };
  if (prefersReducedMotion()) opts.duration = 1;
  let timer;
  try {
    const animation = node.animate(keyframes, opts);
    const limit = (Number(opts.duration) || 0) + (Number(opts.delay) || 0) + ANIMATION_GRACE_MS;
    const expired = new Promise((resolve) => {
      timer = setTimeout(resolve, limit, EXPIRED);
    });
    const outcome = await Promise.race([animation.finished, expired]);
    // Délai dépassé : on place l'animation dans son état final, comme si elle s'était jouée.
    if (outcome === EXPIRED && animation.playState !== 'finished') animation.finish();
  } catch {
    /* animation annulée : sans conséquence */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Découpe `text` pour mettre en évidence `query` (sans innerHTML).
 * @returns {(string|HTMLElement)[]}
 */
export function highlight(text, query) {
  const needle = normalize(query);
  if (!needle) return [text];
  const index = normalize(text).indexOf(needle);
  if (index < 0) return [text];
  return [
    text.slice(0, index),
    h('mark', { text: text.slice(index, index + needle.length) }),
    text.slice(index + needle.length),
  ];
}
