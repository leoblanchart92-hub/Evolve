/**
 * Evolve — Widget matériel : jauge circulaire, détails et courbe d'historique.
 *
 * Purement visuel : il affiche les valeurs qu'on lui fournit. À cette étape,
 * elles proviennent du simulateur (data/demo-hardware.js) et chaque widget
 * porte la pastille « DÉMO ».
 */

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { Sparkline } from './sparkline.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RADIUS = 27;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function circle(className) {
  const node = document.createElementNS(SVG_NS, 'circle');
  node.setAttribute('class', className);
  node.setAttribute('cx', '32');
  node.setAttribute('cy', '32');
  node.setAttribute('r', String(RADIUS));
  return node;
}

/**
 * @param {object} options
 * @param {string} options.id       'cpu' | 'ram' | 'gpu'
 * @param {string} options.title    libellé affiché
 * @param {string} options.glyph    pictogramme
 * @param {number} options.interval intervalle entre deux mesures (ms)
 * @param {number} [options.index]  rang (décale l'animation d'apparition)
 * @param {number[]} [options.history] historique initial de la courbe
 */
export function createHardwareWidget({ id, title, glyph, interval, index = 0, history = [] }) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  const value = circle('hw__gauge-value');
  value.setAttribute('stroke', 'url(#grad-gauge)');
  value.setAttribute('stroke-dasharray', CIRCUMFERENCE.toFixed(2));
  value.setAttribute('stroke-dashoffset', CIRCUMFERENCE.toFixed(2));
  svg.append(circle('hw__gauge-track'), value);

  const percent = h('span', { class: 'tabular', text: '0' });
  const primary = h('p', { class: 'hw__primary tabular' });
  const secondary = h('p', { class: 'hw__secondary tabular' });
  const sparkline = new Sparkline({ interval, history });

  const el = h(
    'section',
    {
      class: 'widget hw glass',
      'aria-label': `${title} (données fictives de démonstration)`,
      dataset: { metric: id },
      style: { '--i': String(index) },
    },
    h(
      'header',
      { class: 'hw__head' },
      icon(glyph, 'duotone'),
      h('h2', { class: 'hw__title', text: title }),
      h('span', {
        class: 'chip chip--demo',
        text: 'Démo',
        'data-tip': 'Données fictives — les mesures réelles arriveront dans une prochaine étape',
      }),
    ),
    h('div', { class: 'hw__gauge' }, svg, h('div', { class: 'hw__percent' }, percent, h('small', { text: '%' }))),
    h('div', { class: 'hw__details' }, primary, secondary),
    sparkline.el,
  );

  return {
    el,
    /**
     * @param {{ load: number, primary: string, secondary: string }} data
     */
    update({ load, primary: primaryText, secondary: secondaryText }) {
      const ratio = Math.min(Math.max(load, 0), 100) / 100;
      value.setAttribute('stroke-dashoffset', (CIRCUMFERENCE * (1 - ratio)).toFixed(2));
      percent.textContent = String(Math.round(load));
      primary.textContent = primaryText;
      secondary.textContent = secondaryText;
      sparkline.push(load);
    },
  };
}
