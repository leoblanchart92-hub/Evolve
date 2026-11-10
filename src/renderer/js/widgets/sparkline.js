/**
 * Evolve — Courbe d'historique défilante (« sparkline »).
 *
 * La courbe est redessinée à chaque nouvelle valeur puis glisse d'un cran vers
 * la gauche pendant l'intervalle : le défilement paraît continu et fluide
 * alors que les données n'arrivent qu'une fois par seconde.
 */

import { h, prefersReducedMotion } from '../core/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STEP = 10; // largeur d'un cran, en unités du viewBox
const HEIGHT = 100;

/**
 * Tracé lissé (courbes de Bézier à tangentes horizontales, sans dépassement).
 * Exporté pour les tests.
 * @param {number[]} values  valeurs entre 0 et 100
 * @returns {string} attribut `d` de la ligne
 */
export function sparklinePath(values, { step = STEP, height = HEIGHT, padding = 6 } = {}) {
  if (!values.length) return '';
  const usable = height - padding * 2;
  const y = (value) => padding + usable * (1 - Math.min(Math.max(value, 0), 100) / 100);
  let d = `M0 ${y(values[0]).toFixed(2)}`;
  for (let i = 1; i < values.length; i += 1) {
    const x0 = (i - 1) * step;
    const x1 = i * step;
    const mid = (x0 + x1) / 2;
    d += `C${mid} ${y(values[i - 1]).toFixed(2)} ${mid} ${y(values[i]).toFixed(2)} ${x1} ${y(values[i]).toFixed(2)}`;
  }
  return d;
}

export class Sparkline {
  #values;
  #points;
  #interval;
  #svg;
  #line;
  #area;
  #animation = null;

  /**
   * @param {{ points?: number, interval?: number, history?: number[] }} [options]
   *        `history` : valeurs initiales (les plus récentes en dernier).
   */
  constructor({ points = 26, interval = 1000, history = [] } = {}) {
    this.#points = points;
    this.#interval = interval;
    // Deux valeurs de plus que la zone visible : une hors-champ de chaque côté.
    const length = points + 2;
    const seed = history.slice(-length);
    const first = seed[0] ?? 0;
    this.#values = [...Array.from({ length: length - seed.length }, () => first), ...seed];

    const width = (points + 1) * STEP;
    this.#svg = document.createElementNS(SVG_NS, 'svg');
    this.#svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    this.#svg.setAttribute('preserveAspectRatio', 'none');
    this.#svg.setAttribute('aria-hidden', 'true');
    this.#svg.style.width = `${((points + 1) / points) * 100}%`;

    this.#area = document.createElementNS(SVG_NS, 'path');
    this.#area.setAttribute('fill', 'url(#grad-spark)');
    this.#line = document.createElementNS(SVG_NS, 'path');
    this.#line.setAttribute('class', 'spark__line');
    this.#svg.append(this.#area, this.#line);

    this.el = h('div', { class: 'spark' });
    this.el.append(this.#svg);
    this.#draw();
  }

  /** Ajoute une valeur (0–100) et fait défiler la courbe d'un cran. */
  push(value) {
    this.#values.push(value);
    this.#values.shift();
    this.#draw();

    this.#animation?.cancel();
    if (prefersReducedMotion()) return;
    const shift = `${-100 / (this.#points + 1)}%`;
    this.#animation = this.#svg.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${shift})` }], {
      duration: this.#interval,
      easing: 'linear',
      fill: 'forwards',
    });
  }

  #draw() {
    const line = sparklinePath(this.#values);
    const lastX = (this.#values.length - 1) * STEP;
    this.#line.setAttribute('d', line);
    this.#area.setAttribute('d', `${line}L${lastX} ${HEIGHT}L0 ${HEIGHT}Z`);
  }
}
