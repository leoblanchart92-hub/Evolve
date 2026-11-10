/**
 * Evolve — Explorateur de fichiers (interface graphique).
 *
 * CONTENU D'EXEMPLE : l'explorateur parcourt une arborescence fictive
 * (data/demo-files.js). Il ne lit ni ne modifie aucun fichier de l'ordinateur.
 * Navigation, sélection, tri, recherche et modes d'affichage sont fonctionnels ;
 * les opérations sur les fichiers (copier, supprimer…) arriveront plus tard.
 */

import { h, highlight } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { normalize } from '../core/text.js';
import { formatFileDate, formatNumber, formatSize, plural } from '../core/format.js';
import { describeNode, isContainer, sortNodes } from '../data/demo-files.js';
import { WALLPAPER_URL } from '../config.js';
import { nodeIcon } from '../shell/file-icon.js';

const QUICK_ACCESS = ['desktop', 'documents', 'pictures', 'music', 'downloads', 'videos'];

const COLUMNS = [
  { key: 'name', label: 'Nom' },
  { key: 'modified', label: 'Modifié le' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Taille', end: true },
];

const SORT_LABELS = { name: 'Nom', modified: 'Date de modification', type: 'Type', size: 'Taille' };

const GB = 1024 ** 3;

class Explorer {
  #win;
  #shell;
  #fs;
  /** Dossier affiché. */
  #current = null;
  #back = [];
  #forward = [];
  #view = 'grid';
  #sort = { key: 'name', direction: 1 };
  #filter = '';
  /** Identifiants sélectionnés. */
  #selection = new Set();
  /** Dernier élément activé (point de départ du clavier et des plages). */
  #cursor = null;
  /** Éléments affichés, dans l'ordre visuel. */
  #items = [];
  /** @type {Map<string, HTMLElement>} */
  #itemEls = new Map();

  // Éléments d'interface
  #buttons = {};
  #crumbs;
  #filterInput;
  #filterClear;
  #sidebarButtons = new Map();
  #content;
  #statusText;
  #statusSelection;
  #viewButtons = {};

  constructor(win, shell) {
    this.#win = win;
    this.#shell = shell;
    this.#fs = shell.files;

    this.el = h(
      'div',
      { class: 'explorer' },
      this.#buildNav(),
      this.#buildCommands(),
      h('div', { class: 'ex-main' }, this.#buildSidebar(), this.#buildContent()),
      this.#buildStatus(),
    );
    this.el.addEventListener('keydown', (event) => this.#onKeyDown(event));
    win.body.append(this.el);
  }

  // --- API (appelée par le gestionnaire de fenêtres) --------------------------

  /** Affiche un emplacement et, éventuellement, y sélectionne un élément. */
  show({ location = 'home', select } = {}) {
    this.#navigate(location, { select });
  }

  onParams(params) {
    this.show(params ?? {});
  }

  destroy() {
    this.#shell.menus.close();
  }

  // --- Construction ------------------------------------------------------------

  #iconButton(glyph, label, onClick, extra = {}) {
    const button = h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, 'data-tip': label, ...extra }, icon(glyph));
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      onClick(button);
    });
    return button;
  }

  #buildNav() {
    this.#buttons.back = this.#iconButton('arrow-left', 'Précédent (Alt+Gauche)', () => this.#goBack());
    this.#buttons.forward = this.#iconButton('arrow-right', 'Suivant (Alt+Droite)', () => this.#goForward());
    this.#buttons.up = this.#iconButton('arrow-up', 'Dossier parent (Alt+Haut)', () => this.#goUp());
    const refresh = this.#iconButton('arrow-clockwise', 'Actualiser (F5)', () => this.#refresh());

    this.#crumbs = h('nav', { class: 'ex-crumbs', 'aria-label': 'Emplacement' });

    this.#filterInput = h('input', { type: 'text', 'aria-label': 'Rechercher dans ce dossier', autocomplete: 'off', spellcheck: 'false' });
    this.#filterClear = h(
      'button',
      { class: 'icon-btn', type: 'button', 'aria-label': 'Effacer la recherche', hidden: true },
      icon('x'),
    );
    this.#filterInput.addEventListener('input', () => this.#setFilter(this.#filterInput.value));
    this.#filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#filterInput.value) {
        event.preventDefault();
        event.stopPropagation();
        this.#setFilter('');
        this.#content.focus({ preventScroll: true });
      } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
        // Passe des résultats au clavier.
        event.preventDefault();
        this.#content.focus({ preventScroll: true });
        if (!this.#selection.size && this.#items.length) this.#selectOnly(this.#items[0].id);
      }
    });
    this.#filterClear.addEventListener('click', () => {
      this.#setFilter('');
      this.#filterInput.focus();
    });

    return h(
      'div',
      { class: 'ex-nav' },
      this.#buttons.back,
      this.#buttons.forward,
      this.#buttons.up,
      refresh,
      this.#crumbs,
      h('label', { class: 'ex-filter' }, icon('magnifying-glass'), this.#filterInput, this.#filterClear),
    );
  }

  #buildCommands() {
    const create = h(
      'button',
      { class: 'btn btn--accent', type: 'button' },
      icon('plus'),
      h('span', { class: 'btn__label', text: 'Nouveau' }),
    );
    create.addEventListener('click', () => this.#preview('Nouveau'));

    const command = (key, glyph, label, extra = {}) => {
      this.#buttons[key] = this.#iconButton(glyph, label, () => this.#preview(label), extra);
      return this.#buttons[key];
    };

    this.#buttons.sort = h(
      'button',
      { class: 'btn btn--ghost', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      icon('arrows-down-up'),
      h('span', { class: 'btn__label', text: 'Trier' }),
      icon('caret-down'),
    );
    this.#buttons.sort.addEventListener('click', () => this.#showSortMenu());

    this.#buttons.view = h(
      'button',
      { class: 'btn btn--ghost', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      icon('squares-four'),
      h('span', { class: 'btn__label', text: 'Affichage' }),
      icon('caret-down'),
    );
    this.#buttons.view.addEventListener('click', () => this.#showViewMenu());

    return h(
      'div',
      { class: 'ex-commands', role: 'toolbar', 'aria-label': 'Commandes' },
      create,
      h('span', { class: 'ex-commands__sep' }),
      command('cut', 'scissors', 'Couper'),
      command('copy', 'copy', 'Copier'),
      command('paste', 'clipboard-text', 'Coller', { 'data-optional': '' }),
      command('rename', 'pencil-simple-line', 'Renommer'),
      command('share', 'share-fat', 'Partager', { 'data-optional': '' }),
      command('delete', 'trash', 'Supprimer'),
      h('span', { class: 'ex-commands__spacer' }),
      this.#buttons.sort,
      this.#buttons.view,
    );
  }

  #buildSidebar() {
    const { places } = this.#fs;
    const entry = (node) => {
      const button = h(
        'button',
        { class: 'ex-side', type: 'button', 'data-tip': node.name, dataset: { id: node.id } },
        nodeIcon(node, { plain: true }),
        h('span', { class: 'truncate', text: node.name }),
      );
      button.addEventListener('click', () => this.#navigate(node.id));
      this.#sidebarButtons.set(node.id, button);
      return button;
    };
    const drives = places.pc.children.filter((node) => node.kind === 'drive');

    return h(
      'aside',
      { class: 'ex-sidebar scroll', 'aria-label': 'Emplacements' },
      entry(places.home),
      h('h3', { class: 'ex-sidebar__title', text: 'Accès rapide' }),
      QUICK_ACCESS.map((key) => entry(places[key])),
      h('h3', { class: 'ex-sidebar__title', text: 'Cet appareil' }),
      entry(places.pc),
      drives.map(entry),
      entry(places.network),
      entry(places.trash),
    );
  }

  #buildContent() {
    this.#content = h('section', {
      class: 'ex-content scroll',
      tabindex: '0',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': 'Contenu du dossier',
    });
    const content = this.#content;
    const itemAt = (event) => {
      const el = event.target instanceof Element ? event.target.closest('.ex-item') : null;
      return el ? this.#items.find((node) => node.id === el.dataset.id) : null;
    };

    content.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.ex-col')) return;
      const node = itemAt(event);
      if (!node) {
        this.#clearSelection();
      } else if (event.ctrlKey || event.metaKey) {
        this.#toggleSelection(node.id);
      } else if (event.shiftKey) {
        this.#selectRange(node.id);
      } else {
        this.#selectOnly(node.id);
      }
    });

    content.addEventListener('dblclick', (event) => {
      const node = itemAt(event);
      if (node) this.#open(node);
    });

    content.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const node = itemAt(event);
      if (node) {
        if (!this.#selection.has(node.id)) this.#selectOnly(node.id);
        this.#showItemMenu(node, event.clientX, event.clientY);
      } else {
        this.#clearSelection();
        this.#showBackgroundMenu(event.clientX, event.clientY);
      }
    });

    return content;
  }

  #buildStatus() {
    this.#statusText = h('span');
    this.#statusSelection = h('span', { class: 'ex-status__selection' });
    this.#viewButtons.list = this.#iconButton('list-bullets', 'Détails', () => this.#setView('list'));
    this.#viewButtons.grid = this.#iconButton('squares-four', 'Grandes icônes', () => this.#setView('grid'));

    return h(
      'footer',
      { class: 'ex-status' },
      h('span', { class: 'ex-status__text' }, this.#statusText, this.#statusSelection),
      h('span', { class: 'ex-status__spacer' }),
      h('span', {
        class: 'chip chip--demo',
        text: "Contenu d'exemple",
        'data-tip': 'Arborescence fictive : vos fichiers ne sont ni lus ni modifiés',
      }),
      this.#viewButtons.list,
      this.#viewButtons.grid,
    );
  }

  // --- Navigation ----------------------------------------------------------------

  #navigate(id, { record = true, select } = {}) {
    const node = this.#fs.get(id);
    if (!node || !isContainer(node)) return;
    if (record && this.#current && node !== this.#current) {
      this.#back.push(this.#current.id);
      this.#forward = [];
    }
    this.#current = node;
    this.#filter = '';
    this.#filterInput.value = '';
    this.#filterClear.hidden = true;
    this.#selection.clear();
    this.#cursor = null;
    this.#render();

    if (select && this.#itemEls.has(select)) {
      this.#selectOnly(select);
      this.#content.focus({ preventScroll: true });
    }
  }

  #goBack() {
    const id = this.#back.pop();
    if (!id) return;
    this.#forward.push(this.#current.id);
    this.#navigate(id, { record: false });
  }

  #goForward() {
    const id = this.#forward.pop();
    if (!id) return;
    this.#back.push(this.#current.id);
    this.#navigate(id, { record: false });
  }

  #parentOf(node) {
    return node.parent && node.parent.kind !== 'root' ? node.parent : null;
  }

  #goUp() {
    const parent = this.#parentOf(this.#current);
    if (parent) this.#navigate(parent.id);
  }

  #refresh() {
    this.#render();
  }

  #setFilter(value) {
    this.#filterInput.value = value;
    this.#filterClear.hidden = value === '';
    const filter = value.trim();
    if (filter === this.#filter) return;
    this.#filter = filter;
    this.#selection.clear();
    this.#cursor = null;
    this.#renderContent();
  }

  #setView(view) {
    if (view === this.#view) return;
    this.#view = view;
    this.#renderContent({ keepSelection: true });
  }

  #setSort(key, direction) {
    if (direction === undefined) {
      // Recliquer sur la colonne active inverse le sens du tri.
      direction = this.#sort.key === key ? -this.#sort.direction : 1;
    }
    this.#sort = { key, direction };
    this.#renderContent({ keepSelection: true });
  }

  // --- Rendu -----------------------------------------------------------------------

  #render() {
    const node = this.#current;
    this.#win.setTitle(`${node.name} — Explorateur de fichiers`);

    // Boutons de navigation
    const setDisabled = (button, disabled) => button.setAttribute('aria-disabled', String(disabled));
    setDisabled(this.#buttons.back, this.#back.length === 0);
    setDisabled(this.#buttons.forward, this.#forward.length === 0);
    setDisabled(this.#buttons.up, !this.#parentOf(node));

    // Fil d'Ariane
    const path = this.#fs.pathTo(node);
    const crumbs = [];
    path.forEach((step, index) => {
      if (index > 0) crumbs.push(icon('caret-right'));
      const crumb = h(
        'button',
        { class: 'ex-crumb', type: 'button', style: { animationDelay: `${index * 35}ms` } },
        index === 0 ? nodeIcon(step, { plain: true }) : null,
        h('span', { text: step.name }),
      );
      crumb.addEventListener('click', () => this.#navigate(step.id));
      crumbs.push(crumb);
    });
    this.#crumbs.replaceChildren(...crumbs);

    // Barre latérale : l'entrée de l'emplacement courant (ou de son plus proche parent).
    let active = null;
    for (let step = node; step && !active; step = step.parent) {
      if (this.#sidebarButtons.has(step.id)) active = step.id;
    }
    for (const [id, button] of this.#sidebarButtons) {
      button.classList.toggle('is-current', id === active);
      if (id === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }

    this.#filterInput.placeholder = `Rechercher dans ${this.#searchRoot().name}`;
    this.#renderContent();
    this.#content.scrollTop = 0;
  }

  /** Racine de la recherche : le dossier courant (ou « Ce PC » depuis un emplacement virtuel). */
  #searchRoot() {
    const node = this.#current;
    return node.kind === 'home' || node.kind === 'place' ? this.#fs.places.pc : node;
  }

  #sorted(nodes) {
    return sortNodes(nodes, this.#sort.key, this.#sort.direction);
  }

  #renderContent({ keepSelection = false } = {}) {
    const node = this.#current;
    const view = h('div', { class: 'ex-view' });
    this.#items = [];
    this.#itemEls.clear();
    if (!keepSelection) {
      this.#selection.clear();
      this.#cursor = null;
    }

    if (this.#filter) {
      this.#renderSearch(view);
    } else if (node.kind === 'home') {
      this.#renderHome(view);
    } else if (node.kind === 'pc') {
      const folders = this.#sorted(node.children.filter((child) => child.kind !== 'drive'));
      const drives = node.children.filter((child) => child.kind === 'drive');
      view.append(this.#section('Dossiers', folders.length), this.#collection(folders));
      view.append(this.#section('Périphériques et lecteurs', drives.length), this.#drives(drives));
    } else if (node.children.length === 0) {
      view.append(
        this.#empty(
          node.kind === 'place' ? node.icon : 'folder-open',
          node.emptyTitle ?? 'Ce dossier est vide',
          node.emptyText ?? 'Aucun élément à afficher pour le moment.',
        ),
      );
    } else {
      view.append(this.#collection(this.#sorted(node.children)));
    }

    this.#content.replaceChildren(view);

    // La sélection ne conserve que les éléments encore affichés.
    for (const id of [...this.#selection]) if (!this.#itemEls.has(id)) this.#selection.delete(id);
    if (this.#cursor && !this.#itemEls.has(this.#cursor)) this.#cursor = null;
    this.#syncSelection();
    this.#syncToolbar();
  }

  #renderHome(view) {
    const { places } = this.#fs;
    const quick = QUICK_ACCESS.map((key) => places[key]);
    const recents = this.#fs.recents(10);
    view.append(
      this.#section('Accès rapide', quick.length),
      this.#grid(quick),
      this.#section('Fichiers récents', recents.length),
      this.#list(recents, { sortable: false }),
    );
  }

  #renderSearch(view) {
    const needle = normalize(this.#filter);
    const root = this.#searchRoot();
    const matches = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (normalize(child.name).includes(needle)) matches.push(child);
        visit(child);
      }
    };
    visit(root);

    if (!matches.length) {
      view.append(
        this.#empty(
          'magnifying-glass',
          `Aucun résultat pour « ${this.#filter} »`,
          `Aucun élément de « ${root.name} » ne correspond à votre recherche.`,
        ),
      );
      return;
    }
    view.append(
      this.#section(`Résultats pour « ${this.#filter} » dans ${root.name}`, matches.length),
      this.#collection(this.#sorted(matches)),
    );
  }

  #section(title, count) {
    return h(
      'h3',
      { class: 'ex-section' },
      h('span', { text: title }),
      count === undefined ? null : h('span', { class: 'ex-section__count tabular', text: formatNumber(count) }),
    );
  }

  /** Affiche des éléments selon le mode courant (grille ou détails). */
  #collection(nodes) {
    return this.#view === 'grid' ? this.#grid(nodes) : this.#list(nodes);
  }

  #register(node, el) {
    this.#items.push(node);
    this.#itemEls.set(node.id, el);
    return el;
  }

  #visual(node) {
    if (node.thumbnail === 'wallpaper') {
      return h('span', { class: 'ex-thumb' }, h('img', { src: WALLPAPER_URL, alt: '', draggable: 'false' }));
    }
    return nodeIcon(node);
  }

  #itemProps(node, className) {
    return { class: `ex-item ${className}`, role: 'option', 'aria-selected': 'false', dataset: { id: node.id } };
  }

  #grid(nodes) {
    return h(
      'div',
      { class: 'ex-grid' },
      nodes.map((node) =>
        this.#register(
          node,
          h(
            'div',
            this.#itemProps(node, 'ex-tile'),
            this.#visual(node),
            h('span', { class: 'ex-tile__name' }, highlight(node.name, this.#filter)),
          ),
        ),
      ),
    );
  }

  #list(nodes, { sortable = true } = {}) {
    const head = h(
      'div',
      { class: 'ex-list__head' },
      COLUMNS.map(({ key, label, end }) => {
        const sorted = sortable && this.#sort.key === key;
        const column = h(
          sortable ? 'button' : 'span',
          {
            class: `ex-col${end ? ' ex-col--end' : ''}${sorted ? ' is-sorted' : ''}${sorted && this.#sort.direction < 0 ? ' is-desc' : ''}`,
            type: sortable ? 'button' : null,
            'data-col': key,
            'data-tip': sortable ? `Trier par ${label.toLowerCase()}` : null,
          },
          h('span', { text: label }),
          sortable ? icon('caret-up', 'fill') : null,
        );
        if (sortable) column.addEventListener('click', () => this.#setSort(key));
        return column;
      }),
    );

    return h(
      'div',
      { class: 'ex-list' },
      head,
      nodes.map((node) =>
        this.#register(
          node,
          h(
            'div',
            this.#itemProps(node, 'ex-row'),
            h('span', { class: 'ex-row__name' }, this.#visual(node), h('span', { class: 'truncate' }, highlight(node.name, this.#filter))),
            h('span', { class: 'ex-row__cell truncate tabular', 'data-col': 'modified', text: formatFileDate(node.modified) }),
            h('span', { class: 'ex-row__cell truncate', 'data-col': 'type', text: describeNode(node).label }),
            h('span', {
              class: 'ex-row__cell ex-row__cell--end truncate tabular',
              'data-col': 'size',
              text: node.kind === 'file' ? formatSize(node.size) : '',
            }),
          ),
        ),
      ),
    );
  }

  #drives(drives) {
    return h(
      'div',
      { class: 'ex-drives' },
      drives.map((drive) => {
        const used = drive.totalBytes - drive.freeBytes;
        const free = `${formatNumber(drive.freeBytes / GB)} Go libres sur ${formatNumber(drive.totalBytes / GB)} Go`;
        return this.#register(
          drive,
          h(
            'div',
            this.#itemProps(drive, 'ex-drive'),
            nodeIcon(drive),
            h('span', { class: 'ex-drive__name truncate', text: drive.name }),
            h(
              'span',
              { class: 'ex-drive__bar', role: 'img', 'aria-label': free },
              h('span', { style: { '--used': `${Math.round((used / drive.totalBytes) * 100)}%` } }),
            ),
            h('span', { class: 'ex-drive__meta truncate tabular', text: free }),
          ),
        );
      }),
    );
  }

  #empty(glyph, title, text) {
    return h('div', { class: 'ex-empty' }, icon(glyph, 'duotone'), h('strong', { text: title }), h('span', { text }));
  }

  // --- Sélection -------------------------------------------------------------------

  #selectOnly(id) {
    this.#selection = new Set([id]);
    this.#cursor = id;
    this.#syncSelection({ reveal: id });
  }

  #toggleSelection(id) {
    if (this.#selection.has(id)) this.#selection.delete(id);
    else this.#selection.add(id);
    this.#cursor = id;
    this.#syncSelection({ reveal: id });
  }

  #selectRange(id) {
    const ids = this.#items.map((node) => node.id);
    const from = Math.max(0, ids.indexOf(this.#cursor ?? id));
    const to = ids.indexOf(id);
    this.#selection = new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
    this.#syncSelection({ reveal: id });
  }

  #clearSelection() {
    if (!this.#selection.size) return;
    this.#selection.clear();
    this.#syncSelection();
  }

  #syncSelection({ reveal } = {}) {
    for (const [id, el] of this.#itemEls) {
      const selected = this.#selection.has(id);
      el.classList.toggle('is-selected', selected);
      el.setAttribute('aria-selected', String(selected));
    }
    if (reveal) this.#itemEls.get(reveal)?.scrollIntoView({ block: 'nearest' });
    this.#syncStatus();
    this.#syncToolbar();
  }

  #selectedNodes() {
    return this.#items.filter((node) => this.#selection.has(node.id));
  }

  #syncStatus() {
    const count = this.#items.length;
    this.#statusText.textContent = this.#filter ? plural(count, 'résultat') : plural(count, 'élément');

    const selected = this.#selectedNodes();
    if (!selected.length) {
      this.#statusSelection.textContent = '';
      return;
    }
    const label = selected.length > 1 ? `${formatNumber(selected.length)} éléments sélectionnés` : '1 élément sélectionné';
    const files = selected.filter((node) => node.kind === 'file');
    const size = files.length === selected.length ? ` · ${formatSize(files.reduce((sum, node) => sum + node.size, 0))}` : '';
    this.#statusSelection.textContent = ` · ${label}${size}`;
  }

  #syncToolbar() {
    const count = this.#selection.size;
    const setDisabled = (key, disabled) => this.#buttons[key].setAttribute('aria-disabled', String(disabled));
    setDisabled('cut', count === 0);
    setDisabled('copy', count === 0);
    setDisabled('paste', true); // presse-papiers vide dans cet aperçu
    setDisabled('rename', count !== 1);
    setDisabled('share', count === 0);
    setDisabled('delete', count === 0);

    this.#viewButtons.grid.classList.toggle('is-on', this.#view === 'grid');
    this.#viewButtons.list.classList.toggle('is-on', this.#view === 'list');
    this.#viewButtons.grid.setAttribute('aria-pressed', String(this.#view === 'grid'));
    this.#viewButtons.list.setAttribute('aria-pressed', String(this.#view === 'list'));
  }

  // --- Clavier ---------------------------------------------------------------------

  #onKeyDown(event) {
    const { key } = event;

    if (event.altKey && key === 'ArrowLeft') return this.#handled(event, () => this.#goBack());
    if (event.altKey && key === 'ArrowRight') return this.#handled(event, () => this.#goForward());
    if (event.altKey && key === 'ArrowUp') return this.#handled(event, () => this.#goUp());
    if (key === 'F5') return this.#handled(event, () => this.#refresh());
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'f') {
      return this.#handled(event, () => this.#filterInput.focus());
    }

    // Les raccourcis suivants ne s'appliquent qu'à la liste des éléments.
    if (event.target !== this.#content) return undefined;

    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'a') {
      return this.#handled(event, () => {
        this.#selection = new Set(this.#items.map((node) => node.id));
        this.#syncSelection();
      });
    }
    if (key === 'Escape' && this.#selection.size) return this.#handled(event, () => this.#clearSelection(), true);
    if (key === 'Backspace') return this.#handled(event, () => this.#goBack());
    if (key === 'Enter') {
      const node = this.#items.find((item) => item.id === this.#cursor && this.#selection.has(item.id));
      if (node) return this.#handled(event, () => this.#open(node));
      return undefined;
    }
    if (key === 'Delete' && this.#selection.size) return this.#handled(event, () => this.#preview('Supprimer'));
    if (key === 'F2' && this.#selection.size === 1) return this.#handled(event, () => this.#preview('Renommer'));

    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
      return this.#handled(event, () => this.#moveCursor(key, event.shiftKey));
    }
    return undefined;
  }

  #handled(event, action, stop = false) {
    event.preventDefault();
    if (stop) event.stopPropagation();
    action();
  }

  #moveCursor(key, extend) {
    const ids = this.#items.map((node) => node.id);
    if (!ids.length) return;
    const index = ids.indexOf(this.#cursor);
    let target;

    if (index < 0) target = ids[0];
    else if (key === 'Home') target = ids[0];
    else if (key === 'End') target = ids[ids.length - 1];
    else if (key === 'ArrowLeft') target = ids[Math.max(0, index - 1)];
    else if (key === 'ArrowRight') target = ids[Math.min(ids.length - 1, index + 1)];
    else target = this.#verticalNeighbour(this.#cursor, key === 'ArrowDown') ?? this.#cursor;

    if (extend && index >= 0) {
      const anchor = this.#cursor;
      this.#selectRange(target);
      this.#cursor = anchor;
    } else {
      this.#selectOnly(target);
    }
  }

  /** Élément situé juste au-dessus / au-dessous (la grille peut avoir plusieurs sections). */
  #verticalNeighbour(id, down) {
    const origin = this.#itemEls.get(id)?.getBoundingClientRect();
    if (!origin) return null;
    const centre = origin.left + origin.width / 2;
    let best = null;
    let bestGap = Infinity;
    let bestOffset = Infinity;
    for (const [otherId, el] of this.#itemEls) {
      if (otherId === id) continue;
      const rect = el.getBoundingClientRect();
      const gap = down ? rect.top - origin.bottom : origin.top - rect.bottom;
      if (gap < -1) continue; // même rangée ou du mauvais côté
      const offset = Math.abs(rect.left + rect.width / 2 - centre);
      if (gap < bestGap - 2 || (Math.abs(gap - bestGap) <= 2 && offset < bestOffset)) {
        best = otherId;
        bestGap = gap;
        bestOffset = offset;
      }
    }
    return best;
  }

  // --- Actions ----------------------------------------------------------------------

  #open(node) {
    if (isContainer(node)) {
      this.#navigate(node.id);
      return;
    }
    this.#shell.toasts.show({
      key: 'explorer-open',
      title: node.name,
      message: "L'ouverture des fichiers arrivera dans une prochaine étape. Ce fichier est un exemple.",
      glyph: describeNode(node).icon,
    });
  }

  /** Action d'aperçu : la commande existe visuellement mais n'agit pas encore. */
  #preview(action) {
    this.#shell.toasts.show({
      key: 'explorer-preview',
      title: `${action} — bientôt disponible`,
      message: "Cette commande arrivera avec la gestion réelle des fichiers. L'explorateur affiche pour l'instant un contenu d'exemple.",
      glyph: 'sparkle',
    });
  }

  #showProperties(node) {
    const details = [describeNode(node).label];
    if (node.kind === 'file') details.push(formatSize(node.size));
    else if (node.kind === 'drive') details.push(`${formatNumber(node.freeBytes / GB)} Go libres`);
    else details.push(plural(node.children.length, 'élément'));
    details.push(`modifié le ${formatFileDate(node.modified)}`);
    this.#shell.toasts.show({
      key: 'explorer-properties',
      title: node.name,
      message: `${details.join(' · ')} (exemple)`,
      glyph: 'info',
      timeout: 6500,
    });
  }

  #showItemMenu(node, x, y) {
    const single = this.#selection.size === 1;
    this.#shell.menus.show({
      x,
      y,
      label: node.name,
      items: [
        single && {
          label: 'Ouvrir',
          glyph: isContainer(node) ? 'folder-open' : 'arrow-square-out',
          hint: 'Entrée',
          onSelect: () => this.#open(node),
        },
        single && { separator: true },
        { label: 'Couper', glyph: 'scissors', hint: 'Ctrl+X', onSelect: () => this.#preview('Couper') },
        { label: 'Copier', glyph: 'copy', hint: 'Ctrl+C', onSelect: () => this.#preview('Copier') },
        single && { label: 'Renommer', glyph: 'pencil-simple-line', hint: 'F2', onSelect: () => this.#preview('Renommer') },
        { label: 'Supprimer', glyph: 'trash', hint: 'Suppr', danger: true, onSelect: () => this.#preview('Supprimer') },
        single && { separator: true },
        single && { label: 'Propriétés', glyph: 'info', onSelect: () => this.#showProperties(node) },
      ],
    });
  }

  #viewItems() {
    return [
      { label: 'Grandes icônes', checked: this.#view === 'grid', onSelect: () => this.#setView('grid') },
      { label: 'Détails', checked: this.#view === 'list', onSelect: () => this.#setView('list') },
    ];
  }

  #sortItems() {
    return Object.entries(SORT_LABELS).map(([key, label]) => ({
      label,
      checked: this.#sort.key === key,
      onSelect: () => this.#setSort(key, this.#sort.key === key ? this.#sort.direction : 1),
    }));
  }

  #showBackgroundMenu(x, y) {
    this.#shell.menus.show({
      x,
      y,
      label: 'Dossier',
      items: [
        { header: 'Affichage' },
        ...this.#viewItems(),
        { header: 'Trier par' },
        ...this.#sortItems(),
        { separator: true },
        { label: 'Actualiser', glyph: 'arrow-clockwise', hint: 'F5', onSelect: () => this.#refresh() },
        { label: 'Nouveau dossier', glyph: 'folder-plus', onSelect: () => this.#preview('Nouveau dossier') },
      ],
    });
  }

  #showSortMenu() {
    this.#shell.menus.show({
      anchor: this.#buttons.sort,
      placement: 'bottom-end',
      label: 'Trier',
      items: [
        { header: 'Trier par' },
        ...this.#sortItems(),
        { separator: true },
        { label: 'Croissant', checked: this.#sort.direction > 0, onSelect: () => this.#setSort(this.#sort.key, 1) },
        { label: 'Décroissant', checked: this.#sort.direction < 0, onSelect: () => this.#setSort(this.#sort.key, -1) },
      ],
    });
  }

  #showViewMenu() {
    this.#shell.menus.show({
      anchor: this.#buttons.view,
      placement: 'bottom-end',
      label: 'Affichage',
      items: this.#viewItems(),
    });
  }
}

/**
 * Monte l'explorateur dans une fenêtre.
 * @param {import('../wm/window.js').AppWindow} win
 * @param {{ location?: string, select?: string }} [params]
 * @param {import('../shell/shell.js').Shell} shell
 */
export function mountExplorer(win, params, shell) {
  const explorer = new Explorer(win, shell);
  explorer.show(params ?? {});
  return explorer;
}
