/**
 * Evolve — Menu Démarrer : recherche, applications, dossiers personnels et
 * alimentation.
 *
 * Tout ce que le menu propose existe. Une application disponible se lance ;
 * une application seulement annoncée est présentée estompée, marquée
 * « Bientôt », et n'ouvre rien — le menu le dit. Les six dossiers personnels
 * s'ouvrent dans l'explorateur de fichiers. Aucun fichier fictif n'est montré.
 *
 * Au clavier : taper lance la recherche ; les flèches mènent d'un élément à
 * son voisin, Début et Fin au premier et au dernier ; Entrée ouvre ; la touche
 * Menu (ou Maj + F10) ouvre le menu d'un élément ; Échap efface la recherche,
 * revient à l'accueil, puis ferme le menu.
 */

import { h, highlight } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { targetIndex } from '../core/spatial.js';
import { normalize } from '../core/text.js';
import { isFullscreen, quitApp, toggleFullscreen } from '../core/platform.js';
import { PLACES } from '../apps/explorer-nav.js';
import { APPS, AVAILABLE_APPS, UPCOMING_APPS, appLabel, isAvailable } from '../data/apps.js';
import { PRODUCT } from '../config.js';
import { Flyout } from './flyouts.js';
import { search } from './search.js';
import { shortcutLabel } from './shortcuts.js';

/** Groupes de résultats, dans l'ordre : [titre, résultats concernés]. */
const RESULT_GROUPS = [
  ['Applications', (result) => result.type === 'app'],
  ['Dossiers personnels', (result) => result.type === 'place'],
  ['Paramètres rapides', (result) => result.type === 'setting'],
];

/** Mention portée par une application annoncée, mais pas encore disponible. */
const UPCOMING_LABEL = 'Bientôt disponible';

function appTile(app) {
  return h('span', { class: 'app-icon', style: { '--g1': app.colors[0], '--g2': app.colors[1] } }, icon(app.glyph, 'fill'));
}

/** Icône d'un dossier personnel : son pictogramme, teinté comme dans l'explorateur. */
function placeIcon(place) {
  const svg = icon(place.icon, 'duotone');
  svg.style.fill = 'url(#grad-violet)';
  return svg;
}

export class StartMenu extends Flyout {
  #shell;
  #input;
  #clear;
  #views;
  #view = 'home';
  #query = '';
  /** Résultats affichés : { result, el }[] dans l'ordre visuel. */
  #rows = [];
  #activeIndex = -1;
  #powerButton;

  /** @param {import('./shell.js').Shell} shell */
  constructor(shell) {
    const el = h('section', {
      class: 'start glass glass--neon',
      role: 'dialog',
      'aria-label': 'Menu Démarrer',
      tabindex: '-1',
    });
    super('start', el);
    this.#shell = shell;

    // --- Recherche ---
    this.#input = h('input', {
      class: 'searchbox__input',
      type: 'text',
      placeholder: 'Rechercher une application, un dossier personnel ou un paramètre',
      'aria-label': 'Rechercher',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.#clear = h(
      'button',
      { class: 'icon-btn searchbox__clear', type: 'button', 'aria-label': 'Effacer la recherche', hidden: true },
      icon('x'),
    );
    this.#clear.addEventListener('click', () => {
      this.#setQuery('');
      this.#input.focus();
    });
    this.#input.addEventListener('input', () => this.#setQuery(this.#input.value, { fromInput: true }));
    this.#input.addEventListener('keydown', (event) => this.#onInputKeyDown(event));

    // --- Vues ---
    this.#views = {
      home: h('div', { class: 'start__view start__view--home scroll is-current' }),
      all: h('div', { class: 'start__view start__view--all scroll' }),
      search: h('div', { class: 'start__view start__view--search scroll', 'aria-live': 'polite' }),
    };
    this.#views.all.inert = true;
    this.#views.search.inert = true;
    this.#buildHome();
    this.#buildAllApps();

    el.append(
      h('div', { class: 'start__search' }, h('label', { class: 'searchbox' }, icon('magnifying-glass'), this.#input, this.#clear)),
      h('div', { class: 'start__views' }, this.#views.home, this.#views.all, this.#views.search),
      this.#buildFooter(),
    );

    el.addEventListener('keydown', (event) => this.#onKeyDown(event));
    el.addEventListener('contextmenu', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-app], [data-place]') : null;
      if (target) this.#showItemMenu(target, event.clientX, event.clientY);
    });
  }

  // --- Cycle de vie du panneau ---------------------------------------------

  onOpen({ focusSearch = false } = {}) {
    this.#setQuery('');
    this.#showView('home');
    for (const view of Object.values(this.#views)) view.scrollTop = 0;
    (focusSearch ? this.#input : this.el).focus({ preventScroll: true });
  }

  onReopen({ focusSearch = false } = {}) {
    if (focusSearch) this.#input.focus({ preventScroll: true });
  }

  onClose() {
    this.#shell.menus.close();
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
  }

  onEscape() {
    if (this.#query) {
      this.#setQuery('');
      this.#input.focus({ preventScroll: true });
      return true;
    }
    if (this.#view === 'all') {
      this.#showView('home');
      this.el.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  // --- Construction ----------------------------------------------------------

  /** Tuile d'une application : lançable, ou estompée et marquée « Bientôt » si elle n'est qu'annoncée. */
  #appButton(app, index) {
    const available = isAvailable(app);
    const button = h(
      'button',
      {
        class: `start-app${available ? '' : ' is-upcoming'}`,
        type: 'button',
        'aria-label': available ? app.name : `${app.name} — ${UPCOMING_LABEL.toLowerCase()}`,
        'aria-disabled': available ? null : 'true',
        'data-tip': available ? null : UPCOMING_LABEL,
        style: { '--i': String(index) },
        dataset: { app: app.id },
      },
      appTile(app),
      h('span', { class: 'start-app__label truncate', text: appLabel(app) }),
    );
    button.addEventListener('click', (event) => this.#activateApp(app, { newWindow: event.shiftKey }));
    return button;
  }

  #buildHome() {
    const allButton = h(
      'button',
      { class: 'btn btn--ghost', type: 'button' },
      'Toutes les applications',
      icon('caret-right'),
    );
    allButton.addEventListener('click', () => {
      this.#showView('all');
      this.#views.all.querySelector('button')?.focus({ preventScroll: true });
    });

    // Les applications disponibles d'abord ; celles qui ne sont qu'annoncées suivent, estompées.
    const grid = h('div', { class: 'start__grid', role: 'group', 'aria-label': 'Applications' });
    [...AVAILABLE_APPS, ...UPCOMING_APPS].forEach((app, index) => grid.append(this.#appButton(app, index)));

    // Dossiers personnels : chacun s'ouvre dans l'explorateur de fichiers.
    const offset = APPS.length;
    const folders = h('div', { class: 'start__reco', role: 'group', 'aria-label': 'Dossiers personnels' });
    PLACES.forEach((place, index) => {
      const button = h(
        'button',
        { class: 'reco', type: 'button', style: { '--i': String(offset + index * 2) }, dataset: { place: place.id } },
        placeIcon(place),
        h(
          'span',
          { class: 'reco__text' },
          h('span', { class: 'reco__name truncate', text: place.name }),
          h('span', { class: 'reco__meta truncate', text: 'Dossier personnel' }),
        ),
      );
      button.addEventListener('click', () => this.#openPlace(place.id));
      folders.append(button);
    });

    this.#views.home.append(
      h(
        'header',
        { class: 'start__head' },
        h('h2', { text: 'Applications' }),
        h(
          'span',
          { class: 'start__head-end' },
          h('span', { class: 'chip chip--soon', text: 'Estompées : bientôt', 'data-tip': "Ces applications ne sont pas encore disponibles : elles n'ouvrent rien" }),
          allButton,
        ),
      ),
      grid,
      h('header', { class: 'start__head' }, h('h2', { text: 'Dossiers' })),
      folders,
    );
  }

  #buildAllApps() {
    const back = h('button', { class: 'btn btn--ghost', type: 'button' }, icon('caret-left'), 'Retour');
    back.addEventListener('click', () => {
      this.#showView('home');
      this.el.focus({ preventScroll: true });
    });

    const collator = new Intl.Collator('fr', { sensitivity: 'base' });
    const sorted = [...APPS].sort((a, b) => collator.compare(a.name, b.name));
    const list = h('div', { class: 'start__list' });
    let letter = '';
    for (const app of sorted) {
      const initial = normalize(app.name).charAt(0).toUpperCase();
      if (initial !== letter) {
        letter = initial;
        list.append(h('h3', { class: 'start__letter', text: letter }));
      }
      const available = isAvailable(app);
      const row = h(
        'button',
        { class: `start-row${available ? '' : ' is-upcoming'}`, type: 'button', 'aria-disabled': available ? null : 'true', dataset: { app: app.id } },
        appTile(app),
        h('span', { class: 'start-row__text' }, h('span', { class: 'start-row__name truncate', text: app.name })),
        available ? null : h('span', { class: 'chip chip--soon', text: 'Bientôt' }),
      );
      row.addEventListener('click', (event) => this.#activateApp(app, { newWindow: event.shiftKey }));
      list.append(row);
    }

    this.#views.all.append(h('header', { class: 'start__head' }, h('h2', { text: 'Toutes les applications' }), back), list);
  }

  #buildFooter() {
    this.#powerButton = h(
      'button',
      {
        class: 'icon-btn start__power',
        type: 'button',
        'aria-label': 'Alimentation',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'data-tip': 'Alimentation',
      },
      icon('power'),
    );
    this.#powerButton.addEventListener('click', () => this.#showPowerMenu());

    return h(
      'footer',
      { class: 'start__footer' },
      h(
        'div',
        { class: 'start__user' },
        h('span', { class: 'start__avatar' }, icon('user', 'fill')),
        h(
          'span',
          { class: 'start__user-text' },
          h('span', { class: 'start__user-name truncate', text: PRODUCT.userName }),
          h('span', { class: 'start__user-meta truncate', text: `${PRODUCT.name} ${PRODUCT.version} · ${PRODUCT.stage}` }),
        ),
      ),
      this.#powerButton,
    );
  }

  // --- Vues et recherche -----------------------------------------------------

  /** Vue affichée : les résultats pendant une recherche, sinon l'accueil ou la liste des applications. */
  #visibleView() {
    return this.#views[this.#query ? 'search' : this.#view];
  }

  #showView(name) {
    this.#view = name;
    const visible = this.#query ? 'search' : name;
    for (const [key, view] of Object.entries(this.#views)) {
      const current = key === visible;
      view.classList.toggle('is-current', current);
      view.inert = !current;
    }
  }

  #setQuery(value, { fromInput = false } = {}) {
    const query = value.trim();
    if (!fromInput) this.#input.value = value;
    this.#clear.hidden = this.#input.value === '';
    if (query === this.#query) return;
    this.#query = query;
    if (query) this.#renderResults();
    this.#showView(this.#view);
  }

  #renderResults() {
    const query = this.#query;
    const view = this.#views.search;
    const results = search(query, { apps: APPS, places: PLACES, isAvailable });
    this.#rows = [];
    this.#activeIndex = -1;
    view.scrollTop = 0;

    if (!results.length) {
      view.replaceChildren(
        h(
          'div',
          { class: 'start__empty' },
          icon('magnifying-glass', 'duotone'),
          h('strong', { text: `Aucun résultat pour « ${query} »` }),
          h('span', { text: 'Essayez le nom d’une application, d’un dossier personnel ou d’un réglage.' }),
        ),
      );
      return;
    }

    const [best, ...others] = results;
    const nodes = [h('h3', { class: 'start__group', text: 'Meilleur résultat' }), this.#resultRow(best, { best: true })];
    for (const [title, belongs] of RESULT_GROUPS) {
      const group = others.filter(belongs);
      if (!group.length) continue;
      nodes.push(h('h3', { class: 'start__group', text: title }));
      for (const result of group) nodes.push(this.#resultRow(result));
    }
    view.replaceChildren(...nodes);
    this.#setActive(0);
  }

  #resultRow(result, { best = false } = {}) {
    const { type, item, available } = result;
    let visual;
    let name;
    let meta;
    const dataset = { type };

    if (type === 'app') {
      visual = appTile(item);
      name = item.name;
      meta = available ? 'Application' : `Application · ${UPCOMING_LABEL.toLowerCase()}`;
      dataset.app = item.id;
    } else if (type === 'place') {
      visual = placeIcon(item);
      name = item.name;
      meta = "Dossier personnel · s'ouvre dans l'explorateur de fichiers";
      dataset.place = item.id;
    } else {
      visual = icon(item.glyph, 'duotone');
      visual.style.fill = 'url(#grad-violet)';
      name = item.label;
      meta = 'Paramètre rapide';
    }

    const el = h(
      'button',
      { class: `start-row${best ? ' start-row--best' : ''}${available ? '' : ' is-upcoming'}`, type: 'button', tabindex: '-1', 'aria-disabled': available ? null : 'true', dataset },
      visual,
      h(
        'span',
        { class: 'start-row__text' },
        h('span', { class: 'start-row__name truncate' }, highlight(name, this.#query)),
        h('span', { class: 'start-row__meta truncate', text: meta }),
      ),
      available ? h('span', { class: 'start-row__hint', text: 'Entrée' }) : h('span', { class: 'chip chip--soon', text: 'Bientôt' }),
    );
    const index = this.#rows.length;
    el.addEventListener('click', () => this.#activateResult(result));
    el.addEventListener('pointermove', () => this.#setActive(index, { scroll: false }));
    this.#rows.push({ result, el });
    return el;
  }

  #setActive(index, { scroll = true } = {}) {
    if (index === this.#activeIndex) return;
    this.#rows[this.#activeIndex]?.el.classList.remove('is-active');
    this.#activeIndex = index;
    const row = this.#rows[index]?.el;
    if (!row) return;
    row.classList.add('is-active');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  // --- Clavier -------------------------------------------------------------------

  #onInputKeyDown(event) {
    if (!this.#query || !this.#rows.length) return;
    const count = this.#rows.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      this.#setActive((this.#activeIndex + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      this.#setActive((this.#activeIndex - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = this.#rows[this.#activeIndex];
      if (row) this.#activateResult(row.result);
    }
  }

  /** Éléments que les flèches parcourent : ceux de la vue affichée, puis le bouton d'alimentation. */
  #navigable() {
    return [...this.#visibleView().querySelectorAll('button'), this.#powerButton].filter((button) => button.getClientRects().length > 0);
  }

  #onKeyDown(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const inInput = target === this.#input;

    // Touche Menu, ou Maj + F10 : menu de l'application ou du dossier.
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const item = target?.closest('[data-app], [data-place]');
      if (item) {
        event.preventDefault();
        const box = item.getBoundingClientRect();
        this.#showItemMenu(item, box.left + box.width / 2, box.top + box.height / 2);
      }
      return;
    }

    // Flèches, Début, Fin : d'un élément à son voisin (pendant une recherche, le champ les garde).
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && !event.shiftKey) {
      if (inInput && (this.#query || event.key !== 'ArrowDown')) return;
      const items = this.#navigable();
      const current = items.indexOf(target);
      event.preventDefault();
      if (current < 0) {
        // Depuis le champ de recherche ou le cadre du menu : la première application (ou le premier résultat).
        const first = this.#visibleView().querySelector('.start-app, .start-row') ?? items[0];
        first?.focus({ preventScroll: true });
        return;
      }
      const index = targetIndex(event.key, current, items.map((item) => item.getBoundingClientRect()));
      if (index >= 0) {
        items[index].focus({ preventScroll: true });
        items[index].scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'ArrowUp') {
        // Rien au-dessus : retour au champ de recherche.
        this.#input.focus({ preventScroll: true });
      }
      return;
    }

    // Toute frappe de caractère dans le menu alimente la recherche.
    if (!inInput && event.key.length === 1 && event.key !== ' ') this.#input.focus();
  }

  // --- Actions ---------------------------------------------------------------

  /** Lance une application disponible ; une application seulement annoncée le dit, sans rien ouvrir. */
  #activateApp(app, { newWindow = false } = {}) {
    const shell = this.#shell;
    if (!isAvailable(app)) {
      shell.announceUpcoming(app);
      return;
    }
    shell.flyouts.close();
    shell.launch(app.id, { target: newWindow ? 'new' : 'auto' });
  }

  /** Ouvre un dossier personnel dans l'explorateur de fichiers. */
  #openPlace(placeId, { newWindow = false } = {}) {
    const shell = this.#shell;
    shell.flyouts.close();
    shell.launch('explorer', { params: { location: placeId }, target: newWindow ? 'new' : 'auto' });
  }

  #activateResult({ type, item }) {
    if (type === 'app') {
      this.#activateApp(item);
    } else if (type === 'place') {
      this.#openPlace(item.id);
    } else {
      // Paramètre rapide : ouvre le panneau et met le réglage en évidence.
      this.#shell.flyouts.open('quick-settings', { highlight: item.id });
    }
  }

  /** Menu d'une application ou d'un dossier personnel (clic droit, touche Menu). */
  #showItemMenu(target, x, y) {
    const shell = this.#shell;
    const app = target.dataset.app ? APPS.find((entry) => entry.id === target.dataset.app) : null;
    const place = target.dataset.place ? PLACES.find((entry) => entry.id === target.dataset.place) : null;
    if (app && !isAvailable(app)) {
      shell.menus.show({ x, y, label: app.name, items: [{ header: app.name }, { label: UPCOMING_LABEL, glyph: 'clock', disabled: true }] });
    } else if (app) {
      shell.menus.show({
        x,
        y,
        label: app.name,
        items: [
          { header: app.name },
          { label: 'Ouvrir', glyph: 'arrow-square-out', hint: 'Entrée', onSelect: () => this.#activateApp(app) },
          app.multiWindow && { label: 'Ouvrir une nouvelle fenêtre', glyph: 'app-window', hint: shortcutLabel('open-explorer'), onSelect: () => this.#activateApp(app, { newWindow: true }) },
        ],
      });
    } else if (place) {
      shell.menus.show({
        x,
        y,
        label: place.name,
        items: [
          { header: place.name },
          { label: 'Ouvrir', glyph: 'folder-open', hint: 'Entrée', onSelect: () => this.#openPlace(place.id) },
          { label: 'Ouvrir dans une nouvelle fenêtre', glyph: 'app-window', onSelect: () => this.#openPlace(place.id, { newWindow: true }) },
        ],
      });
    }
  }

  #showPowerMenu() {
    const shell = this.#shell;
    const fullscreen = isFullscreen();
    shell.menus.show({
      anchor: this.#powerButton,
      placement: 'top-end',
      label: 'Alimentation',
      items: [
        {
          label: fullscreen ? 'Quitter le plein écran' : 'Plein écran',
          glyph: fullscreen ? 'corners-in' : 'corners-out',
          hint: 'F11',
          onSelect: async () => {
            if (!(await toggleFullscreen())) {
              shell.toasts.show({
                key: 'fullscreen',
                title: 'Plein écran indisponible',
                message: 'Le navigateur a refusé le passage en plein écran.',
                glyph: 'warning-circle',
              });
            }
          },
        },
        { separator: true },
        {
          label: `Quitter ${PRODUCT.name}`,
          glyph: 'sign-out',
          danger: true,
          onSelect: () => {
            if (quitApp()) return;
            shell.flyouts.close();
            shell.toasts.show({
              key: 'quit',
              title: `Quitter ${PRODUCT.name}`,
              message: "Cette action ferme l'application de bureau. Dans un navigateur, fermez simplement l'onglet.",
              glyph: 'sign-out',
            });
          },
        },
      ],
    });
  }
}
