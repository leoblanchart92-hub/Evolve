/**
 * Evolve — Bascule entre fenêtres (Ctrl + Tab).
 *
 * Tant que Ctrl reste enfoncé, un panneau présente les fenêtres ouvertes, de
 * la plus récemment utilisée à la plus ancienne — fenêtres réduites
 * comprises. Chaque pression sur Tab désigne la suivante (avec Maj : la
 * précédente). Relâcher Ctrl active la fenêtre désignée ; Échap renonce et
 * laisse tout en l'état. C'est l'équivalent, à l'intérieur d'Evolve, de
 * Alt + Tab — que Windows garde pour ses propres fenêtres.
 */

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

export class WindowSwitcher {
  #layer;
  #wm;
  #el = null;
  /** @type {import('./window.js').AppWindow[]} fenêtres présentées, dans l'ordre d'usage */
  #windows = [];
  #index = 0;

  /**
   * @param {HTMLElement} layer  calque qui reçoit le panneau
   * @param {import('./window-manager.js').WindowManager} wm
   */
  constructor(layer, wm) {
    this.#layer = layer;
    this.#wm = wm;
    // Une fenêtre fermée pendant que le panneau est ouvert n'y reste pas proposée.
    wm.on('change', () => {
      if (this.isOpen && this.#windows.some((win) => win.closing || !wm.get(win.id))) this.cancel();
    });
  }

  get isOpen() {
    return this.#el !== null;
  }

  /** Fenêtre désignée, ou `null` si le panneau est fermé. */
  get selected() {
    return this.isOpen ? this.#windows[this.#index] : null;
  }

  /**
   * Ouvre le panneau, ou désigne la fenêtre suivante (`direction` : 1) ou
   * précédente (-1). À l'ouverture, la fenêtre désignée est celle qui était
   * utilisée juste avant la fenêtre active.
   * @returns {boolean} faux s'il n'y a aucune fenêtre à présenter
   */
  step(direction = 1) {
    if (!this.isOpen) {
      const windows = this.#wm.recent.filter((win) => !win.closing);
      if (windows.length === 0) return false;
      this.#windows = windows;
      // La fenêtre active est en tête : le premier cran mène à la suivante. Sans fenêtre active, à la première.
      const from = this.#wm.active ? 0 : direction > 0 ? -1 : 0;
      this.#index = this.#wrap(from + direction);
      this.#render();
      return true;
    }
    this.#select(this.#wrap(this.#index + direction));
    return true;
  }

  /** Active la fenêtre désignée (en la rétablissant si elle était réduite) et ferme le panneau. */
  commit() {
    if (!this.isOpen) return;
    const win = this.#windows[this.#index];
    this.#close();
    if (win && !win.closing && this.#wm.get(win.id)) this.#wm.activate(win);
  }

  /** Ferme le panneau sans rien changer. */
  cancel() {
    if (this.isOpen) this.#close();
  }

  /**
   * Touche pressée pendant que le panneau est ouvert (hors Ctrl + Tab).
   * @returns {boolean} vrai si la touche a été employée par le panneau
   */
  handleKey(event) {
    if (!this.isOpen) return false;
    if (event.key === 'Escape') this.cancel();
    else if (event.key === 'Enter') this.commit();
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') this.step(1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') this.step(-1);
    else if (event.key === 'Home') this.#select(0);
    else if (event.key === 'End') this.#select(this.#windows.length - 1);
    else return false;
    return true;
  }

  #wrap(index) {
    const count = this.#windows.length;
    return ((index % count) + count) % count;
  }

  #select(index) {
    this.#index = index;
    const items = [...this.#el.querySelectorAll('.switcher__item')];
    items.forEach((item, position) => {
      const current = position === index;
      item.classList.toggle('is-selected', current);
      item.setAttribute('aria-selected', String(current));
      if (current) {
        this.#el.setAttribute('aria-activedescendant', item.id);
        item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }

  #render() {
    const list = h(
      'div',
      { class: 'switcher__list', role: 'presentation' },
      this.#windows.map((win, position) => {
        const item = h(
          'div',
          { class: 'switcher__item', role: 'option', id: `switcher-${win.id}`, 'aria-selected': 'false', dataset: { window: win.id } },
          h('span', { class: 'app-icon', style: { '--g1': win.app.colors[0], '--g2': win.app.colors[1] } }, icon(win.app.glyph, 'fill')),
          h('span', { class: 'switcher__title truncate', text: win.title }),
          win.minimized ? h('span', { class: 'switcher__state', text: 'Réduite' }) : null,
        );
        // À la souris : survoler désigne, cliquer active.
        item.addEventListener('pointermove', () => {
          if (this.#index !== position) this.#select(position);
        });
        item.addEventListener('click', () => {
          this.#select(position);
          this.commit();
        });
        return item;
      }),
    );
    this.#el = h(
      'div',
      { class: 'switcher', role: 'listbox', 'aria-label': 'Fenêtres ouvertes', tabindex: '-1' },
      h('div', { class: 'switcher__panel glass glass--menu glass--neon' }, list, h('p', { class: 'switcher__hint', text: 'Tab : fenêtre suivante · relâcher Ctrl : afficher · Échap : annuler' })),
    );
    // Un clic à côté du panneau y renonce.
    this.#el.addEventListener('pointerdown', (event) => {
      if (event.target === this.#el) {
        event.preventDefault();
        this.cancel();
      }
    });
    this.#layer.append(this.#el);
    this.#select(this.#index);
  }

  #close() {
    const el = this.#el;
    this.#el = null;
    this.#windows = [];
    el.classList.add('is-closing');
    el.addEventListener('animationend', (event) => event.target === el && el.remove());
    setTimeout(() => el.remove(), 220); // filet de sécurité
  }
}
