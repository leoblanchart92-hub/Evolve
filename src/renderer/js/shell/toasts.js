/**
 * Evolve — Notifications éphémères (« toasts ») affichées en bas à droite.
 */

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { TIMING } from '../config.js';

export class Toasts {
  #container;
  #byKey = new Map();

  constructor(container) {
    this.#container = container;
  }

  /**
   * Affiche une notification éphémère.
   * @param {object} options
   * @param {string} options.title
   * @param {string} [options.message]
   * @param {string} [options.glyph]    pictogramme de la tuile
   * @param {string[]} [options.colors] dégradé de la tuile
   * @param {string} [options.key]      une même clé remplace la notification
   *                                    existante au lieu d'en empiler une autre
   * @param {number} [options.timeout]
   */
  show({ title, message = '', glyph = 'info', colors = ['#d3b0ff', '#7c3aed'], key, timeout = TIMING.toast }) {
    if (key && this.#byKey.has(key)) this.#dismiss(this.#byKey.get(key), { immediate: true });

    const tile = h('span', { class: 'app-icon', style: { '--g1': colors[0], '--g2': colors[1] } }, icon(glyph, 'fill'));
    const close = h(
      'button',
      { class: 'icon-btn toast__close', type: 'button', 'aria-label': 'Fermer la notification' },
      icon('x'),
    );
    const el = h(
      'div',
      { class: 'toast glass glass--menu' },
      tile,
      h('p', { class: 'toast__title', text: title }),
      close,
      message ? h('p', { class: 'toast__message', text: message }) : null,
    );

    const toast = { el, key, timer: 0 };
    const arm = () => {
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => this.#dismiss(toast), timeout);
    };

    close.addEventListener('click', () => this.#dismiss(toast));
    el.addEventListener('pointerenter', () => clearTimeout(toast.timer));
    el.addEventListener('pointerleave', arm);

    if (key) this.#byKey.set(key, toast);
    this.#container.append(el);
    arm();
    return toast;
  }

  #dismiss(toast, { immediate = false } = {}) {
    clearTimeout(toast.timer);
    if (toast.key && this.#byKey.get(toast.key) === toast) this.#byKey.delete(toast.key);
    if (immediate) {
      toast.el.remove();
      return;
    }
    if (toast.el.classList.contains('is-leaving')) return;
    toast.el.classList.add('is-leaving');
    toast.el.addEventListener('animationend', () => toast.el.remove(), { once: true });
    setTimeout(() => toast.el.remove(), 400); // filet de sécurité
  }
}
