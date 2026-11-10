/**
 * Evolve — Bureau : icônes, sélection, ouverture et menu contextuel.
 * (Le fond d'écran est déclaré dans index.html et n'est jamais modifié.)
 */

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { DESKTOP_ICONS } from '../data/apps.js';
import { ui } from './ui-state.js';

export class Desktop {
  #shell;
  #grid;
  #buttons = new Map();
  #selected = null;

  /**
   * @param {HTMLElement} el
   * @param {import('./shell.js').Shell} shell
   */
  constructor(el, shell) {
    this.el = el;
    this.#shell = shell;
    this.#grid = h('div', { class: 'desktop__icons', role: 'group', 'aria-label': 'Icônes du bureau' });
    el.append(this.#grid);
    this.#render();

    // Clic sur une zone vide : désélectionne et retire le focus des fenêtres.
    el.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.desktop-icon')) return;
      this.#select(null);
      shell.wm.blurAll();
    });

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const button = event.target.closest('.desktop-icon');
      if (button) {
        const item = DESKTOP_ICONS.find((entry) => entry.id === button.dataset.id);
        this.#select(item.id);
        shell.menus.show({
          x: event.clientX,
          y: event.clientY,
          label: item.name,
          items: [{ label: 'Ouvrir', glyph: 'arrow-square-out', onSelect: () => this.#open(item) }],
        });
      } else {
        this.#showDesktopMenu(event.clientX, event.clientY);
      }
    });

    ui.subscribe('desktopIconsVisible', (visible) => {
      this.#grid.classList.toggle('is-hidden', !visible);
      this.#grid.inert = !visible;
      if (!visible) this.#select(null);
    });
  }

  /** Rejoue l'animation d'apparition des icônes (« Actualiser »). */
  refresh() {
    this.#select(null);
    this.#render();
  }

  #render() {
    this.#buttons.clear();
    this.#grid.replaceChildren(
      ...DESKTOP_ICONS.map((item, index) => {
        const button = h(
          'button',
          {
            class: 'desktop-icon',
            type: 'button',
            'aria-label': item.name,
            dataset: { id: item.id },
            style: { '--i': String(index) },
          },
          h(
            'span',
            { class: 'app-icon', style: { '--g1': item.colors[0], '--g2': item.colors[1] } },
            icon(item.glyph, 'fill'),
          ),
          h('span', { class: 'desktop-icon__label', text: item.name }),
        );
        button.addEventListener('click', () => this.#select(item.id));
        button.addEventListener('dblclick', () => this.#open(item));
        button.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.#open(item);
          }
        });
        button.addEventListener('focus', () => this.#select(item.id));
        this.#buttons.set(item.id, button);
        return button;
      }),
    );
  }

  #select(id) {
    if (this.#selected === id) return;
    this.#buttons.get(this.#selected)?.classList.remove('is-selected');
    this.#selected = id;
    this.#buttons.get(id)?.classList.add('is-selected');
  }

  #open(item) {
    const button = this.#buttons.get(item.id);
    this.#shell.launch(item.open.app, {
      params: item.open.location ? { location: item.open.location } : undefined,
      origin: button?.querySelector('.app-icon')?.getBoundingClientRect(),
    });
  }

  #showDesktopMenu(x, y) {
    const shell = this.#shell;
    shell.menus.show({
      x,
      y,
      label: 'Bureau',
      items: [
        { label: 'Actualiser', glyph: 'arrows-clockwise', onSelect: () => this.refresh() },
        { separator: true },
        {
          label: 'Afficher les icônes du bureau',
          checked: ui.get('desktopIconsVisible'),
          onSelect: () => ui.toggle('desktopIconsVisible'),
        },
        {
          label: 'Afficher les widgets',
          checked: ui.get('widgetsVisible'),
          onSelect: () => ui.toggle('widgetsVisible'),
        },
        { separator: true },
        { label: "Ouvrir l'Explorateur de fichiers", glyph: 'folder', onSelect: () => shell.launch('explorer') },
        { label: 'Paramètres', glyph: 'gear-six', onSelect: () => shell.launch('settings') },
      ],
    });
  }
}
