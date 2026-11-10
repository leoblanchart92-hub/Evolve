/**
 * Evolve — Menu Démarrer : recherche, grille d'applications épinglées,
 * liste de toutes les applications, éléments recommandés et alimentation.
 */

import { h, highlight } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { normalize } from '../core/text.js';
import { formatRelative } from '../core/format.js';
import { isFullscreen, quitApp, toggleFullscreen } from '../core/platform.js';
import { APPS, START_PINNED, appLabel, getApp } from '../data/apps.js';
import { describeNode, isContainer } from '../data/demo-files.js';
import { PRODUCT } from '../config.js';
import { Flyout } from './flyouts.js';
import { nodeIcon } from './file-icon.js';
import { search } from './search.js';

const RESULT_GROUPS = [
  ['app', 'Applications'],
  ['file', 'Fichiers et dossiers'],
  ['setting', 'Paramètres rapides'],
];

function appTile(app) {
  return h('span', { class: 'app-icon', style: { '--g1': app.colors[0], '--g2': app.colors[1] } }, icon(app.glyph, 'fill'));
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
      placeholder: 'Rechercher des applications, des fichiers et des paramètres',
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

    // Toute frappe de caractère dans le menu alimente la recherche.
    el.addEventListener('keydown', (event) => {
      if (event.target === this.#input) return;
      if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        this.#input.focus();
      }
    });
  }

  // --- Cycle de vie du panneau ---------------------------------------------

  onOpen({ focusSearch = false } = {}) {
    this.#setQuery('');
    this.#showView('home');
    for (const view of Object.values(this.#views)) view.scrollTop = 0;
    this.#renderRecommended();
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
      return true;
    }
    if (this.#view === 'all') {
      this.#showView('home');
      return true;
    }
    return false;
  }

  // --- Construction ----------------------------------------------------------

  #buildHome() {
    const allButton = h(
      'button',
      { class: 'btn btn--ghost', type: 'button' },
      'Toutes les applications',
      icon('caret-right'),
    );
    allButton.addEventListener('click', () => this.#showView('all'));

    const grid = h('div', { class: 'start__grid', role: 'group', 'aria-label': 'Applications épinglées' });
    START_PINNED.forEach((appId, index) => {
      const app = getApp(appId);
      const button = h(
        'button',
        { class: 'start-app', type: 'button', 'aria-label': app.name, style: { '--i': String(index) }, dataset: { app: app.id } },
        appTile(app),
        h('span', { class: 'start-app__label truncate', text: appLabel(app) }),
      );
      button.addEventListener('click', () => this.#launch(app.id));
      grid.append(button);
    });

    this.recommended = h('div', { class: 'start__reco', role: 'group', 'aria-label': 'Recommandé' });

    this.#views.home.append(
      h('header', { class: 'start__head' }, h('h2', { text: 'Épinglées' }), allButton),
      grid,
      h(
        'header',
        { class: 'start__head' },
        h('h2', { text: 'Recommandé' }),
        h('span', {
          class: 'chip chip--demo',
          text: 'Exemples',
          'data-tip': 'Fichiers fictifs : vos documents ne sont pas consultés',
        }),
      ),
      this.recommended,
    );
  }

  #renderRecommended() {
    const now = new Date();
    const offset = START_PINNED.length;
    this.recommended.replaceChildren(
      ...this.#shell.files.recents(6).map((node, index) => {
        const button = h(
          'button',
          { class: 'reco', type: 'button', style: { '--i': String(offset + index * 2) } },
          nodeIcon(node),
          h(
            'span',
            { class: 'reco__text' },
            h('span', { class: 'reco__name truncate', text: node.name }),
            h('span', { class: 'reco__meta truncate', text: `${formatRelative(node.modified, now)} · ${node.parent.name}` }),
          ),
        );
        button.addEventListener('click', () => this.#openNode(node));
        return button;
      }),
    );
  }

  #buildAllApps() {
    const back = h('button', { class: 'btn btn--ghost', type: 'button' }, icon('caret-left'), 'Retour');
    back.addEventListener('click', () => this.#showView('home'));

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
      const row = h(
        'button',
        { class: 'start-row', type: 'button', dataset: { app: app.id } },
        appTile(app),
        h('span', { class: 'start-row__text' }, h('span', { class: 'start-row__name truncate', text: app.name })),
      );
      row.addEventListener('click', () => this.#launch(app.id));
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
    const results = search(query, { apps: APPS, files: this.#shell.files });
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
          h('span', { text: 'Essayez le nom d’une application, d’un fichier ou d’un réglage.' }),
        ),
      );
      return;
    }

    const [best, ...others] = results;
    const nodes = [h('h3', { class: 'start__group', text: 'Meilleur résultat' }), this.#resultRow(best, { best: true })];
    for (const [type, title] of RESULT_GROUPS) {
      const group = others.filter((result) => result.type === type);
      if (!group.length) continue;
      nodes.push(h('h3', { class: 'start__group', text: title }));
      for (const result of group) nodes.push(this.#resultRow(result));
    }
    view.replaceChildren(...nodes);
    this.#setActive(0);
  }

  #resultRow(result, { best = false } = {}) {
    const { type, item } = result;
    let visual;
    let name;
    let meta;

    if (type === 'app') {
      visual = appTile(item);
      name = item.name;
      meta = 'Application';
    } else if (type === 'file') {
      visual = nodeIcon(item);
      name = item.name;
      const location = this.#shell.files.pathTo(item.parent).map((node) => node.name).join(' › ');
      meta = `${describeNode(item).label} · ${location}`;
    } else {
      visual = icon(item.glyph, 'duotone');
      visual.style.fill = 'url(#grad-violet)';
      name = item.label;
      meta = 'Paramètre rapide';
    }

    const el = h(
      'button',
      { class: `start-row${best ? ' start-row--best' : ''}`, type: 'button', tabindex: '-1', dataset: { type } },
      visual,
      h(
        'span',
        { class: 'start-row__text' },
        h('span', { class: 'start-row__name truncate' }, highlight(name, this.#query)),
        h('span', { class: 'start-row__meta truncate', text: meta }),
      ),
      h('span', { class: 'start-row__hint', text: 'Entrée' }),
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

  #onInputKeyDown(event) {
    if (!this.#query || !this.#rows.length) return;
    const count = this.#rows.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.#setActive((this.#activeIndex + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.#setActive((this.#activeIndex - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = this.#rows[this.#activeIndex];
      if (row) this.#activateResult(row.result);
    }
  }

  // --- Actions ---------------------------------------------------------------

  #launch(appId, options) {
    const shell = this.#shell;
    shell.flyouts.close();
    shell.launch(appId, options);
  }

  /** Ouvre l'explorateur sur un élément : le dossier lui-même, ou le dossier du fichier (sélectionné). */
  #openNode(node) {
    const params = isContainer(node) ? { location: node.id } : { location: node.parent.id, select: node.id };
    this.#launch('explorer', { params });
  }

  #activateResult({ type, item }) {
    if (type === 'app') {
      this.#launch(item.id);
    } else if (type === 'file') {
      this.#openNode(item);
    } else {
      // Paramètre rapide : ouvre le panneau et met le réglage en évidence.
      this.#shell.flyouts.open('quick-settings', { highlight: item.id });
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
