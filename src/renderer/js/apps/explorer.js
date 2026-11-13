/**
 * Evolve — Explorateur de fichiers (interface graphique).
 *
 * L'explorateur parcourt les vrais dossiers de l'ordinateur — Bureau,
 * Documents, Téléchargements, Images, Musique, Vidéos et lecteurs — et y
 * effectue de vraies opérations : nouveau dossier, renommer, couper, copier,
 * coller, envoyer à la Corbeille, ouvrir un fichier.
 *
 * Il ne touche jamais au disque lui-même. Il interroge le service « files »
 * de l'application de bureau pour lire les dossiers (src/services/files.js),
 * et lui demande chaque opération (src/services/file-operations.js) : c'est
 * elle qui contrôle chaque chemin et qui agit. Rien n'est jamais supprimé
 * définitivement ni remplacé. La navigation est tenue par explorer-nav.js,
 * le déroulement des opérations par explorer-actions.js.
 *
 * Dans un simple navigateur (aperçu de développement), aucun dossier n'est
 * lisible et aucune opération n'existe : l'explorateur l'annonce et n'affiche
 * aucun fichier fictif.
 */

import { h, highlight } from '../core/dom.js';
import { fileOperations } from '../core/file-operations.js';
import { describeNode, sortNodes } from '../core/file-types.js';
import { formatFileDate, formatNumber, formatSize, plural } from '../core/format.js';
import { icon } from '../core/icons.js';
import { services } from '../core/services.js';
import { nodeIcon } from '../shell/file-icon.js';
import { createFileClipboard, FileActions } from './explorer-actions.js';
import { Navigator, PLACES, visibleNodes } from './explorer-nav.js';

const COLUMNS = [
  { key: 'name', label: 'Nom' },
  { key: 'modified', label: 'Modifié le' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Taille', end: true },
];

const SORT_LABELS = { name: 'Nom', modified: 'Date de modification', type: 'Type', size: 'Taille' };

/** Délai avant d'annoncer un chargement : une lecture rapide ne fait pas clignoter le contenu. */
const LOADING_DELAY_MS = 250;

/**
 * Éléments coupés ou copiés, en attente d'être collés. Ce presse-papiers est
 * interne à Evolve et dure le temps de la session : il survit à la fermeture
 * de la fenêtre de l'explorateur. Celui de Windows n'est ni lu ni modifié.
 */
const clipboard = createFileClipboard();

class Explorer {
  #win;
  #shell;
  /** Navigation : emplacement courant, historique, page à afficher. */
  #nav;
  /** Opérations sur les fichiers : nouveau dossier, renommer, couper, copier, coller, Corbeille, ouvrir. */
  #actions;
  #unwatchClipboard;
  /** Emplacement de la page affichée (pour distinguer une actualisation d'un déplacement). */
  #shownKey = null;
  #view = 'grid';
  #sort = { key: 'name', direction: 1 };
  #filter = '';
  /** Afficher aussi les éléments que l'Explorateur de Windows masque. */
  #showHidden = false;
  /** Nombre d'éléments masqués de la page affichée. */
  #hiddenCount = 0;
  /** Identifiants sélectionnés. */
  #selection = new Set();
  /** Dernier élément activé (point de départ du clavier et des plages). */
  #cursor = null;
  /** Éléments affichés, dans l'ordre visuel. */
  #items = [];
  /** @type {Map<string, HTMLElement>} */
  #itemEls = new Map();
  #loadingTimer = null;
  #destroyed = false;

  // Éléments d'interface
  #buttons = {};
  #crumbs;
  /** Étapes du fil d'Ariane : { step, crumb, separator } ; les premières sont repliées si la place manque. */
  #crumbParts = [];
  #crumbsMore = null;
  #crumbsObserver = null;
  #filterInput;
  #filterClear;
  #sidebarButtons = new Map();
  /** Lecteurs de la barre latérale : leurs boutons et leur liste actuelle. */
  #driveList;
  #driveButtons = new Map();
  #content;
  #statusText;
  #statusSelection;
  /** Pastille de la barre d'état : éléments coupés ou copiés, en attente d'être collés. */
  #clipboardChip;
  #viewButtons = {};

  constructor(win, shell) {
    this.#win = win;
    this.#shell = shell;
    this.#nav = new Navigator({
      files: {
        available: services.available,
        places: () => services.call('files', 'places'),
        list: (path) => services.call('files', 'list', path),
      },
      onChange: () => this.#onNavigation(),
    });
    this.#actions = new FileActions({
      operations: fileOperations,
      dialogs: shell.dialogs,
      toasts: shell.toasts,
      clipboard,
      view: {
        // Pendant une lecture, aucun dossier n'est affiché : aucune commande ne s'applique.
        page: () => (this.#nav.loading ? null : this.#nav.page),
        reload: () => this.#nav.reload(),
        select: (paths) => this.#selectPaths(paths),
        changed: () => this.#syncToolbar(),
      },
    });

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
    this.#unwatchClipboard = clipboard.onChange(() => this.#syncClipboard());
    this.#syncClipboard();

    // Fenêtre redimensionnée : le fil d'Ariane replie ou déplie ses premiers dossiers.
    this.#crumbsObserver = new ResizeObserver(() => this.#fitCrumbs());
    this.#crumbsObserver.observe(this.#crumbs);
  }

  // --- API (appelée par le gestionnaire de fenêtres) --------------------------

  /**
   * Affiche un emplacement : « home », « pc », « network », « trash » ou un
   * dossier personnel (« desktop », « documents », « downloads »…).
   */
  show({ location = 'home' } = {}) {
    this.#nav.open(location);
  }

  onParams(params) {
    this.show(params ?? {});
  }

  destroy() {
    this.#destroyed = true;
    clearTimeout(this.#loadingTimer);
    this.#crumbsObserver.disconnect();
    this.#unwatchClipboard();
    this.#actions.dispose();
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
    this.#buttons.back = this.#iconButton('arrow-left', 'Précédent (Alt+Gauche)', () => this.#nav.goBack());
    this.#buttons.forward = this.#iconButton('arrow-right', 'Suivant (Alt+Droite)', () => this.#nav.goForward());
    this.#buttons.up = this.#iconButton('arrow-up', 'Dossier parent (Alt+Haut)', () => this.#nav.goUp());
    const refresh = this.#iconButton('arrow-clockwise', 'Actualiser (F5)', () => this.#nav.refresh());

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
      { class: 'btn btn--accent', type: 'button', 'data-tip': 'Nouveau dossier (Ctrl+Maj+N)', dataset: { command: 'new-folder' } },
      icon('plus'),
      h('span', { class: 'btn__label', text: 'Nouveau dossier' }),
    );
    create.addEventListener('click', () => {
      if (create.getAttribute('aria-disabled') !== 'true') this.#actions.newFolder();
    });
    this.#buttons.create = create;

    const command = (key, glyph, label, run, extra = {}) => {
      this.#buttons[key] = this.#iconButton(glyph, label, run, { ...extra, 'data-command': key });
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
      command('cut', 'scissors', 'Couper (Ctrl+X)', () => this.#actions.cut(this.#selectedNodes())),
      command('copy', 'copy', 'Copier (Ctrl+C)', () => this.#actions.copy(this.#selectedNodes())),
      command('paste', 'clipboard-text', 'Coller (Ctrl+V)', () => this.#actions.paste()),
      command('rename', 'pencil-simple-line', 'Renommer (F2)', () => this.#renameSelected()),
      command('delete', 'trash', 'Envoyer à la Corbeille (Suppr)', () => this.#actions.trash(this.#selectedNodes())),
      h('span', { class: 'ex-commands__spacer' }),
      this.#buttons.sort,
      this.#buttons.view,
    );
  }

  /** Entrée de la barre latérale ; `key` est l'identifiant que la page annonce dans `active`. */
  #sideEntry(key, node, location) {
    const button = h(
      'button',
      { class: 'ex-side', type: 'button', 'data-tip': node.name, dataset: { id: key } },
      nodeIcon(node, { plain: true }),
      h('span', { class: 'truncate', text: node.name }),
    );
    button.addEventListener('click', () => this.#nav.open(location));
    return button;
  }

  #buildSidebar() {
    const entry = (key, node, location) => {
      const button = this.#sideEntry(key, node, location);
      this.#sidebarButtons.set(key, button);
      return button;
    };
    // Les lecteurs sont ajoutés ici dès que l'application de bureau les a indiqués.
    this.#driveList = h('div', { class: 'ex-sidebar__drives' });

    return h(
      'aside',
      { class: 'ex-sidebar scroll', 'aria-label': 'Emplacements' },
      entry('home', { kind: 'place', name: 'Accueil', icon: 'house' }, 'home'),
      h('h3', { class: 'ex-sidebar__title', text: 'Accès rapide' }),
      PLACES.map((place) => entry(`place:${place.id}`, { kind: 'folder', name: place.name, icon: place.icon }, place.id)),
      h('h3', { class: 'ex-sidebar__title', text: 'Cet appareil' }),
      entry('pc', { kind: 'place', name: 'Ce PC', icon: 'desktop' }, 'pc'),
      this.#driveList,
      entry('network', { kind: 'place', name: 'Réseau', icon: 'network' }, 'network'),
      entry('trash', { kind: 'place', name: 'Corbeille', icon: 'trash' }, 'trash'),
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

    // Éléments coupés ou copiés : affichée seulement quand il y a quelque chose à coller.
    this.#clipboardChip = h('span', { class: 'chip chip--accent ex-status__clipboard', hidden: true });
    const preview = services.available
      ? null
      : h('span', {
          class: 'chip chip--demo',
          text: 'Aperçu',
          'data-tip': "Aperçu dans un navigateur : aucun dossier de l'ordinateur n'est lu",
        });

    return h(
      'footer',
      { class: 'ex-status' },
      h('span', { class: 'ex-status__text' }, this.#statusText, this.#statusSelection),
      h('span', { class: 'ex-status__spacer' }),
      this.#clipboardChip,
      preview,
      this.#viewButtons.list,
      this.#viewButtons.grid,
    );
  }

  // --- Navigation ----------------------------------------------------------------

  /** La navigation a changé d'état : lecture en cours, ou nouvelle page prête. */
  #onNavigation() {
    if (this.#destroyed) return;
    const nav = this.#nav;
    const setDisabled = (button, disabled) => button.setAttribute('aria-disabled', String(disabled));
    setDisabled(this.#buttons.back, !nav.canGoBack);
    setDisabled(this.#buttons.forward, !nav.canGoForward);
    setDisabled(this.#buttons.up, !nav.page?.up);

    if (nav.loading) {
      // Le contenu précédent reste affiché ; seule une lecture lente est annoncée.
      this.#content.setAttribute('aria-busy', 'true');
      this.#loadingTimer ??= setTimeout(() => {
        this.#loadingTimer = null;
        if (!this.#destroyed && this.#nav.loading) this.#showLoading();
      }, LOADING_DELAY_MS);
      return;
    }
    clearTimeout(this.#loadingTimer);
    this.#loadingTimer = null;
    this.#content.removeAttribute('aria-busy');
    this.#render();
  }

  #showLoading() {
    this.#items = [];
    this.#itemEls.clear();
    this.#selection.clear();
    this.#cursor = null;
    const loading = this.#empty('arrows-clockwise', 'Lecture du dossier…', 'Le contenu de cet emplacement est en cours de lecture.');
    loading.classList.add('ex-empty--loading');
    this.#content.replaceChildren(h('div', { class: 'ex-view' }, loading));
    this.#syncStatus();
    this.#syncToolbar();
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

  #toggleHidden() {
    this.#showHidden = !this.#showHidden;
    this.#renderContent({ keepSelection: true });
  }

  // --- Rendu -----------------------------------------------------------------------

  #render() {
    const page = this.#nav.page;
    if (!page) return;
    // Même emplacement : c'est une actualisation, la recherche et la sélection sont conservées.
    const moved = page.key !== this.#shownKey;
    this.#shownKey = page.key;
    this.#win.setTitle(`${page.title} — Explorateur de fichiers`);
    // État de la page, lisible par les outils de test : nature, dossier réel, code d'erreur.
    this.#content.dataset.page = page.kind;
    this.#content.dataset.path = page.location?.path ?? '';
    this.#content.dataset.code = page.code ?? '';

    this.#renderCrumbs(page.crumbs);
    this.#syncSidebar(page.active);

    this.#filterInput.placeholder = `Rechercher dans ${page.title}`;
    if (moved) {
      this.#filter = '';
      this.#filterInput.value = '';
      this.#filterClear.hidden = true;
    }
    this.#renderContent({ keepSelection: !moved });
    if (moved) this.#content.scrollTop = 0;
  }

  /** Fil d'Ariane : « Ce PC », puis chaque dossier jusqu'à celui qui est affiché. */
  #renderCrumbs(steps) {
    this.#crumbParts = steps.map((step, index) => {
      const current = index === steps.length - 1;
      const crumb = h(
        'button',
        {
          class: `ex-crumb${current ? ' is-current' : ''}`,
          type: 'button',
          'aria-current': current ? 'location' : null,
          style: { animationDelay: `${Math.min(index, 6) * 35}ms` },
        },
        index === 0 ? nodeIcon({ kind: 'place', icon: step.icon }, { plain: true }) : null,
        h('span', { text: step.label }),
      );
      crumb.addEventListener('click', () => this.#nav.open(step.location));
      return { step, crumb, separator: index > 0 ? icon('caret-right') : null };
    });

    // « … » : remplace, quand la place manque, les dossiers les plus proches de la racine.
    const more = h('button', {
      class: 'ex-crumb ex-crumb--more',
      type: 'button',
      text: '…',
      'aria-label': 'Dossiers parents',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'data-tip': 'Dossiers parents',
      hidden: true,
    });
    more.addEventListener('click', () => {
      this.#shell.menus.show({
        anchor: more,
        placement: 'bottom-start',
        label: 'Dossiers parents',
        items: this.#crumbParts
          .filter((part) => part.crumb.hidden)
          .map(({ step }) => ({ label: step.label, glyph: 'folder', onSelect: () => this.#nav.open(step.location) })),
      });
    });
    this.#crumbsMore = { button: more, separator: icon('caret-right') };
    this.#crumbsMore.separator.toggleAttribute('hidden', true);

    const [first, ...others] = this.#crumbParts;
    this.#crumbs.replaceChildren(
      first.crumb,
      this.#crumbsMore.separator,
      more,
      ...others.flatMap((part) => [part.separator, part.crumb]),
    );
    this.#fitCrumbs();
  }

  /**
   * Replie dans « … » autant de dossiers qu'il le faut pour que le dossier
   * affiché reste lisible : d'abord les plus proches de la racine, comme
   * l'Explorateur de Windows. « Ce PC » et le dossier affiché restent visibles.
   */
  #fitCrumbs() {
    const parts = this.#crumbParts;
    const more = this.#crumbsMore;
    if (!more || parts.length === 0) return;
    const bar = this.#crumbs;
    const collapse = (count) => {
      parts.forEach((part, index) => {
        const folded = index >= 1 && index <= count;
        part.crumb.hidden = folded;
        part.separator?.toggleAttribute('hidden', folded);
      });
      more.button.hidden = count === 0;
      more.separator.toggleAttribute('hidden', count === 0);
    };

    // Mesure sans rétrécissement : chaque nom occupe sa largeur entière.
    bar.classList.add('is-measuring');
    const foldable = Math.max(0, parts.length - 2);
    let count = 0;
    collapse(count);
    while (count < foldable && bar.scrollWidth > bar.clientWidth) {
      count += 1;
      collapse(count);
    }
    bar.classList.remove('is-measuring');
  }

  /** Barre latérale : lecteurs connus et entrée de l'emplacement courant. */
  #syncSidebar(active) {
    const drives = this.#nav.drives;
    const ids = drives.map((drive) => drive.id);
    if (ids.join('\n') !== [...this.#driveButtons.keys()].join('\n')) {
      this.#driveButtons = new Map(drives.map((drive) => [drive.id, this.#sideEntry(drive.id, drive, drive.location)]));
      this.#driveList.replaceChildren(...this.#driveButtons.values());
    }
    for (const [id, button] of [...this.#sidebarButtons, ...this.#driveButtons]) {
      button.classList.toggle('is-current', id === active);
      if (id === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }

  #sorted(nodes) {
    return sortNodes(nodes, this.#sort.key, this.#sort.direction);
  }

  #renderContent({ keepSelection = false } = {}) {
    const page = this.#nav.page;
    if (!page) return;
    const view = h('div', { class: 'ex-view' });
    this.#items = [];
    this.#itemEls.clear();
    this.#hiddenCount = 0;
    if (!keepSelection) {
      this.#selection.clear();
      this.#cursor = null;
    }

    if (page.message) {
      // Information, erreur d'accès ou aperçu sans service : un message, aucun élément.
      view.append(this.#empty(page.message.glyph, page.message.title, page.message.text));
    } else {
      const options = { filter: this.#filter, showHidden: this.#showHidden };
      const all = page.sections.flatMap((section) => section.nodes);
      const visible = visibleNodes(all, options);
      this.#hiddenCount = this.#showHidden ? 0 : all.filter((node) => node.hidden).length;

      if (page.truncated) {
        view.append(
          h(
            'p',
            { class: 'ex-notice' },
            icon('info'),
            h('span', { text: `Ce dossier est très volumineux : seuls ses ${formatNumber(page.limit)} premiers éléments sont affichés.` }),
          ),
        );
      }

      if (this.#filter) {
        if (visible.length) {
          view.append(
            this.#section(`Résultats pour « ${this.#filter} » dans ${page.title}`, visible.length),
            this.#collection(this.#sorted(visible)),
          );
        } else {
          view.append(
            this.#empty(
              'magnifying-glass',
              `Aucun résultat pour « ${this.#filter} »`,
              `Aucun élément de « ${page.title} » ne correspond à votre recherche.`,
            ),
          );
        }
      } else if (page.kind === 'folder' && visible.length === 0) {
        view.append(
          all.length
            ? this.#empty('folder-open', 'Aucun élément à afficher', 'Ce dossier ne contient que des éléments masqués. Le menu Affichage permet de les montrer.')
            : this.#empty('folder-open', 'Ce dossier est vide', 'Aucun élément à afficher pour le moment.'),
        );
      } else {
        for (const section of page.sections) {
          const nodes = visibleNodes(section.nodes, options);
          if (section.title) view.append(this.#section(section.title, nodes.length));
          if (section.layout === 'drives') {
            view.append(nodes.length ? this.#drives(nodes) : h('p', { class: 'ex-notice', text: 'Aucun lecteur détecté.' }));
          } else if (section.layout === 'grid') {
            view.append(this.#grid(nodes));
          } else {
            view.append(this.#collection(this.#sorted(nodes)));
          }
        }
      }
    }

    this.#content.replaceChildren(view);

    // La sélection ne conserve que les éléments encore affichés.
    for (const id of [...this.#selection]) if (!this.#itemEls.has(id)) this.#selection.delete(id);
    if (this.#cursor && !this.#itemEls.has(this.#cursor)) this.#cursor = null;
    this.#syncSelection();
    this.#syncToolbar();
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

  #itemProps(node, className) {
    // Estompés : les éléments masqués par Windows, et un dossier personnel introuvable.
    const dimmed = node.hidden || node.available === false ? ' is-dimmed' : '';
    // Coupé : en attente d'être déplacé par « Coller ».
    const cut = clipboard.isCut(node.path) ? ' is-cut' : '';
    return { class: `ex-item ${className}${dimmed}${cut}`, role: 'option', 'aria-selected': 'false', dataset: { id: node.id, kind: node.kind } };
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
            nodeIcon(node),
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
            h('span', { class: 'ex-row__name' }, nodeIcon(node), h('span', { class: 'truncate' }, highlight(node.name, this.#filter))),
            h('span', {
              class: 'ex-row__cell truncate tabular',
              'data-col': 'modified',
              text: node.modified ? formatFileDate(node.modified) : '',
            }),
            h('span', { class: 'ex-row__cell truncate', 'data-col': 'type', text: describeNode(node).label }),
            h('span', {
              class: 'ex-row__cell ex-row__cell--end truncate tabular',
              'data-col': 'size',
              text: node.kind === 'file' && node.size !== null ? formatSize(node.size) : '',
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
        // Capacité inconnue (lecteur qui ne l'indique pas) : pas de jauge.
        const known = typeof drive.totalBytes === 'number' && typeof drive.freeBytes === 'number' && drive.totalBytes > 0;
        const free = known ? `${formatSize(drive.freeBytes)} libres sur ${formatSize(drive.totalBytes)}` : 'Capacité inconnue';
        const used = known ? Math.round(((drive.totalBytes - drive.freeBytes) / drive.totalBytes) * 100) : 0;
        return this.#register(
          drive,
          h(
            'div',
            this.#itemProps(drive, 'ex-drive'),
            nodeIcon(drive),
            h('span', { class: 'ex-drive__name truncate', text: drive.name }),
            known ? h('span', { class: 'ex-drive__bar', role: 'img', 'aria-label': free }, h('span', { style: { '--used': `${used}%` } })) : null,
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
    const page = this.#nav.page;
    if (!page || page.message || this.#nav.loading) {
      // Message (erreur, aperçu…) ou lecture en cours : aucun décompte à annoncer.
      this.#statusText.textContent = '';
      this.#statusSelection.textContent = '';
      return;
    }
    const count = this.#items.length;
    const hidden = this.#hiddenCount ? ` · ${plural(this.#hiddenCount, 'élément masqué', 'éléments masqués')}` : '';
    this.#statusText.textContent = `${this.#filter ? plural(count, 'résultat') : plural(count, 'élément')}${hidden}`;

    const selected = this.#selectedNodes();
    if (!selected.length) {
      this.#statusSelection.textContent = '';
      return;
    }
    const label = selected.length > 1 ? `${formatNumber(selected.length)} éléments sélectionnés` : '1 élément sélectionné';
    const sized = selected.every((node) => node.kind === 'file' && node.size !== null);
    const size = sized ? ` · ${formatSize(selected.reduce((sum, node) => sum + node.size, 0))}` : '';
    this.#statusSelection.textContent = ` · ${label}${size}`;
  }

  /** Une commande inutilisable est désactivée : sélection vide, page sans dossier réel, rien à coller, opération en cours. */
  #syncToolbar() {
    const can = this.#actions.commands(this.#selectedNodes());
    const setDisabled = (key, disabled) => this.#buttons[key].setAttribute('aria-disabled', String(disabled));
    setDisabled('create', !can.newFolder);
    setDisabled('cut', !can.cut);
    setDisabled('copy', !can.copy);
    setDisabled('paste', !can.paste);
    setDisabled('rename', !can.rename);
    setDisabled('delete', !can.trash);

    this.#viewButtons.grid.classList.toggle('is-on', this.#view === 'grid');
    this.#viewButtons.list.classList.toggle('is-on', this.#view === 'list');
    this.#viewButtons.grid.setAttribute('aria-pressed', String(this.#view === 'grid'));
    this.#viewButtons.list.setAttribute('aria-pressed', String(this.#view === 'list'));
  }

  // --- Clavier ---------------------------------------------------------------------

  #onKeyDown(event) {
    const { key } = event;

    if (event.altKey && key === 'ArrowLeft') return this.#handled(event, () => this.#nav.goBack());
    if (event.altKey && key === 'ArrowRight') return this.#handled(event, () => this.#nav.goForward());
    if (event.altKey && key === 'ArrowUp') return this.#handled(event, () => this.#nav.goUp());
    if (key === 'F5') return this.#handled(event, () => this.#nav.refresh());
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
    // Échap, sans sélection : les éléments coupés ne sont plus en attente d'être déplacés.
    if (key === 'Escape' && clipboard.mode === 'cut') return this.#handled(event, () => clipboard.clear(), true);
    if (key === 'Backspace') return this.#handled(event, () => this.#nav.goBack());

    // Opérations sur les fichiers (AltGr, qui vaut Ctrl+Alt, n'en déclenche aucune).
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const letter = key.toLowerCase();
      if (letter === 'c') return this.#handled(event, () => this.#actions.copy(this.#selectedNodes()));
      if (letter === 'x') return this.#handled(event, () => this.#actions.cut(this.#selectedNodes()));
      if (letter === 'v') return this.#handled(event, () => this.#actions.paste());
      if (letter === 'n' && event.shiftKey) return this.#handled(event, () => this.#actions.newFolder());
    }
    if (key === 'Enter') {
      const node = this.#items.find((item) => item.id === this.#cursor && this.#selection.has(item.id));
      if (node) return this.#handled(event, () => this.#open(node));
      return undefined;
    }
    // Suppr envoie à la Corbeille, après confirmation ; il n'existe aucune suppression définitive.
    if (key === 'Delete' && this.#selection.size) return this.#handled(event, () => this.#actions.trash(this.#selectedNodes()));
    if (key === 'F2' && this.#selection.size === 1) return this.#handled(event, () => this.#renameSelected());

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

    if (key === 'Home') target = ids[0];
    else if (key === 'End') target = ids[ids.length - 1];
    else if (index < 0) target = ids[0];
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
    // Dossier, lecteur ou lien : on s'y rend. Le service vérifie où un lien mène réellement.
    if (node.location) {
      this.#nav.open(node.location);
      return;
    }
    // Fichier : confié à l'application que Windows lui associe (après confirmation, sauf pour un simple contenu).
    if (node.kind === 'file') {
      this.#actions.open(node);
      return;
    }
    this.#shell.toasts.show({
      key: 'explorer-open',
      title: node.name,
      message: "Cet élément n'est ni un fichier ni un dossier : il ne peut pas être ouvert.",
      glyph: describeNode(node).icon,
    });
  }

  #renameSelected() {
    const [node] = this.#selectedNodes();
    if (node && this.#selection.size === 1) this.#actions.rename(node);
  }

  /** Sélectionne les éléments désignés par leur chemin : ceux qui viennent d'être créés, renommés ou collés. */
  #selectPaths(paths) {
    const wanted = new Set(paths.map((path) => path.toLowerCase()));
    const shown = () => this.#items.filter((node) => typeof node.path === 'string' && wanted.has(node.path.toLowerCase())).map((node) => node.id);
    let ids = shown();
    // Écartés par la recherche en cours : elle est effacée, pour qu'ils apparaissent.
    if (!ids.length && this.#filter) {
      this.#setFilter('');
      ids = shown();
    }
    if (!ids.length) return;
    this.#selection = new Set(ids);
    this.#cursor = ids[0];
    this.#syncSelection({ reveal: ids[0] });
    // Le clavier agit aussitôt sur ces éléments (F2, Suppr, Ctrl+C…), sauf s'il est occupé ailleurs.
    const active = document.activeElement;
    if (!active || active === document.body || this.el.contains(active)) this.#content.focus({ preventScroll: true });
  }

  /** Presse-papiers modifié : pastille de la barre d'état, éléments coupés estompés, bouton « Coller ». */
  #syncClipboard() {
    const count = clipboard.size;
    const cut = clipboard.mode === 'cut';
    this.#clipboardChip.hidden = count === 0;
    if (count) {
      this.#clipboardChip.textContent = `${plural(count, 'élément')} à ${cut ? 'déplacer' : 'coller'}`;
      this.#clipboardChip.dataset.mode = clipboard.mode;
      this.#clipboardChip.dataset.tip = cut
        ? 'Éléments coupés : « Coller » (Ctrl+V) les déplace dans le dossier affiché'
        : 'Éléments copiés : « Coller » (Ctrl+V) les copie dans le dossier affiché';
    }
    for (const node of this.#items) this.#itemEls.get(node.id)?.classList.toggle('is-cut', clipboard.isCut(node.path));
    this.#syncToolbar();
  }

  #showProperties(node) {
    const details = [describeNode(node).label];
    if (node.kind === 'file' && node.size !== null) details.push(formatSize(node.size));
    else if (node.kind === 'drive' && typeof node.freeBytes === 'number') details.push(`${formatSize(node.freeBytes)} libres`);
    if (node.modified) details.push(`modifié le ${formatFileDate(node.modified)}`);
    // Élément d'un dossier : son identifiant est son chemin complet.
    if (node.location?.path || node.kind === 'file') details.push(node.location?.path ?? node.id);
    this.#shell.toasts.show({
      key: 'explorer-properties',
      title: node.name,
      message: details.join(' · '),
      glyph: 'info',
      timeout: 6500,
    });
  }

  #showItemMenu(node, x, y) {
    const single = this.#selection.size === 1;
    const nodes = this.#selectedNodes();
    // Une commande inutilisable reste visible, mais désactivée.
    const can = this.#actions.commands(nodes);
    this.#shell.menus.show({
      x,
      y,
      label: node.name,
      items: [
        single && {
          label: 'Ouvrir',
          glyph: node.location ? 'folder-open' : 'arrow-square-out',
          hint: 'Entrée',
          disabled: !can.open,
          onSelect: () => this.#open(node),
        },
        single && { separator: true },
        { label: 'Couper', glyph: 'scissors', hint: 'Ctrl+X', disabled: !can.cut, onSelect: () => this.#actions.cut(nodes) },
        { label: 'Copier', glyph: 'copy', hint: 'Ctrl+C', disabled: !can.copy, onSelect: () => this.#actions.copy(nodes) },
        single && { label: 'Renommer', glyph: 'pencil-simple-line', hint: 'F2', disabled: !can.rename, onSelect: () => this.#actions.rename(node) },
        { label: 'Envoyer à la Corbeille', glyph: 'trash', hint: 'Suppr', danger: true, disabled: !can.trash, onSelect: () => this.#actions.trash(nodes) },
        single && { separator: true },
        single && { label: 'Propriétés', glyph: 'info', onSelect: () => this.#showProperties(node) },
      ],
    });
  }

  #viewItems() {
    return [
      { label: 'Grandes icônes', checked: this.#view === 'grid', onSelect: () => this.#setView('grid') },
      { label: 'Détails', checked: this.#view === 'list', onSelect: () => this.#setView('list') },
      { separator: true },
      { label: 'Éléments masqués', checked: this.#showHidden, onSelect: () => this.#toggleHidden() },
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
    const can = this.#actions.commands([]);
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
        { label: 'Actualiser', glyph: 'arrow-clockwise', hint: 'F5', onSelect: () => this.#nav.refresh() },
        { separator: true },
        { label: 'Coller', glyph: 'clipboard-text', hint: 'Ctrl+V', disabled: !can.paste, onSelect: () => this.#actions.paste() },
        { label: 'Nouveau dossier', glyph: 'folder-plus', hint: 'Ctrl+Maj+N', disabled: !can.newFolder, onSelect: () => this.#actions.newFolder() },
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
 * @param {{ location?: string }} [params]  emplacement à afficher (voir `Explorer.show`)
 * @param {import('../shell/shell.js').Shell} shell
 */
export function mountExplorer(win, params, shell) {
  const explorer = new Explorer(win, shell);
  explorer.show(params ?? {});
  return explorer;
}
