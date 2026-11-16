/**
 * Evolve — Bureau : icônes, sélection, ouverture et menu contextuel.
 * (Le fond d'écran est déclaré dans index.html et n'est jamais modifié.)
 *
 * Chaque icône ouvre une application disponible (voir data/apps.js) : un
 * double-clic, ou la touche Entrée, ouvre son emplacement dans une fenêtre de
 * l'explorateur — celle qui l'affiche déjà, sinon une nouvelle.
 *
 * Au clavier : une seule icône est dans le parcours de la touche Tab ; les
 * flèches mènent à l'icône voisine, Début et Fin à la première et à la
 * dernière, Entrée ouvre, la touche Menu (ou Maj + F10) ouvre le menu de
 * l'icône, Échap retire la sélection.
 */

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { targetIndex } from '../core/spatial.js';
import { DESKTOP_ICONS, getApp } from '../data/apps.js';
import { shortcutLabel } from './shortcuts.js';
import { ui } from './ui-state.js';

export class Desktop {
  #shell;
  #grid;
  /** @type {Map<string, HTMLButtonElement>} */
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
      if (button) this.#showIconMenu(button, event.clientX, event.clientY);
      else this.#showDesktopMenu(event.clientX, event.clientY);
    });

    this.#grid.addEventListener('keydown', (event) => this.#onKeyDown(event));
    // Le clavier arrive sur le bureau : plus aucune fenêtre n'est active, comme après un clic sur le bureau.
    this.#grid.addEventListener('focusin', () => shell.wm.blurAll());

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

  /**
   * Donne le clavier au bureau : à l'icône sélectionnée, sinon à la première.
   * @returns {boolean} faux si les icônes sont masquées
   */
  focus() {
    if (!ui.get('desktopIconsVisible')) return false;
    const button = this.#buttons.get(this.#selected) ?? this.#buttons.values().next().value;
    if (!button) return false;
    this.#focusIcon(button);
    return true;
  }

  /**
   * Donne le clavier à une icône : elle est sélectionnée, et plus aucune
   * fenêtre n'est active. Fait ici, et pas seulement à l'événement « focus » :
   * il n'est pas émis tant que la fenêtre d'Evolve n'est pas celle que Windows
   * tient pour active.
   */
  #focusIcon(button) {
    button.focus({ preventScroll: true });
    this.#select(button.dataset.id);
    this.#shell.wm.blurAll();
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
            // Une seule icône dans le parcours de Tab : la première, puis celle qui est sélectionnée.
            tabindex: index === 0 ? '0' : '-1',
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
    const button = this.#buttons.get(id);
    if (!button) return;
    button.classList.add('is-selected');
    for (const other of this.#buttons.values()) other.tabIndex = other === button ? 0 : -1;
  }

  /**
   * Ouvre l'icône : son emplacement, dans la fenêtre de l'explorateur qui
   * l'affiche déjà, sinon dans une nouvelle fenêtre.
   * @param {object} item
   * @param {{ newWindow?: boolean }} [options]  toujours dans une nouvelle fenêtre
   */
  #open(item, { newWindow = false } = {}) {
    const button = this.#buttons.get(item.id);
    this.#shell.launch(item.open.app, {
      params: item.open.location ? { location: item.open.location } : undefined,
      origin: button?.querySelector('.app-icon')?.getBoundingClientRect(),
      target: newWindow ? 'new' : 'auto',
    });
  }

  #onKeyDown(event) {
    const button = event.target instanceof Element ? event.target.closest('.desktop-icon') : null;
    if (!button || event.ctrlKey || event.altKey || event.metaKey) return;
    const item = DESKTOP_ICONS.find((entry) => entry.id === button.dataset.id);

    if (event.key === 'Enter') {
      event.preventDefault();
      this.#open(item);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const box = button.getBoundingClientRect();
      this.#showIconMenu(button, box.left + box.width / 2, box.top + box.height / 2);
    } else if (event.key === 'Escape' && this.#selected) {
      // Retire la sélection ; le clavier reste sur l'icône.
      this.#buttons.get(this.#selected)?.classList.remove('is-selected');
      this.#selected = null;
    } else if (!event.shiftKey) {
      const buttons = [...this.#buttons.values()];
      const index = targetIndex(event.key, buttons.indexOf(button), buttons.map((other) => other.getBoundingClientRect()));
      if (index < 0) return;
      event.preventDefault();
      this.#focusIcon(buttons[index]);
    }
  }

  #showIconMenu(button, x, y) {
    const item = DESKTOP_ICONS.find((entry) => entry.id === button.dataset.id);
    if (!item) return;
    this.#select(item.id);
    const app = getApp(item.open.app);
    this.#shell.menus.show({
      x,
      y,
      label: item.name,
      items: [
        { header: item.name },
        { label: 'Ouvrir', glyph: 'arrow-square-out', hint: 'Entrée', onSelect: () => this.#open(item) },
        app?.multiWindow && { label: 'Ouvrir dans une nouvelle fenêtre', glyph: 'app-window', onSelect: () => this.#open(item, { newWindow: true }) },
      ],
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
        {
          label: "Nouvelle fenêtre de l'explorateur",
          glyph: 'folder',
          hint: shortcutLabel('open-explorer'),
          onSelect: () => shell.launch('explorer', { target: 'new' }),
        },
      ],
    });
  }
}
