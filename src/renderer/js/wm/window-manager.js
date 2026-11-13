/**
 * Evolve — Gestionnaire de fenêtres.
 *
 * Crée les fenêtres — une application peut en avoir plusieurs —, tient leur
 * empilement et la fenêtre active (stack.js), les limites de l'écran,
 * l'ancrage sur une moitié de l'écran, le clavier (une seule fenêtre le
 * détient, et Tab n'en sort pas), et informe le reste de l'interface (barre
 * des tâches) des changements.
 */

import { rem } from '../core/dom.js';
import { Emitter } from '../core/events.js';
import { centeredRect, cascadeRect, clampWindowPosition, fitRectToArea, isRect, reachableRect, snapRect, snapZoneAt } from './geometry.js';
import { WindowStack } from './stack.js';
import { AppWindow } from './window.js';

/** Dimensions par défaut d'une fenêtre, en rem (elles suivent l'échelle de l'interface). */
const DEFAULT_SIZE = Object.freeze({ w: 46, h: 30, minW: 22, minH: 14 });

/** Nombre maximal de fenêtres ouvertes à la fois. */
export const MAX_WINDOWS = 12;

/** Rang d'empilement de la fenêtre la plus au fond (les suivantes s'ajoutent au-dessus). */
const BASE_Z = 10;

/** Éléments d'une fenêtre que la touche Tab parcourt, dans l'ordre de la page. */
function tabStops(root) {
  return [...root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter(
    (node) => node.tabIndex >= 0 && !node.disabled && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0,
  );
}

export class WindowManager extends Emitter {
  #layer;
  #getAnchorRect;
  #menus;
  #placement;
  #onLimit;
  #hint;
  #stack = new WindowStack();
  /** @type {Map<string, AppWindow>} fenêtres ouvertes, dans l'ordre d'ouverture */
  #byId = new Map();
  #sequence = 0;
  #notifyQueued = false;
  /** Aperçu de la disposition proposée pendant un déplacement vers un bord de l'écran. */
  #preview;
  #previewZone = null;

  /**
   * @param {HTMLElement} layer  calque qui contient les fenêtres (zone de travail)
   * @param {object} options
   * @param {(appId: string) => DOMRect|null} options.getAnchorRect  icône de la barre des tâches (cible des animations)
   * @param {{ show: (menu: object) => void }} [options.menus]  menus contextuels (menu de la fenêtre)
   * @param {{ load: (appId: string) => ({ rect: object, maximized: boolean } | null), save: (appId: string, placement: { rect: object, maximized: boolean }) => void }} [options.placement]
   *        emplacement retenu de la fenêtre d'une application, d'une ouverture à l'autre
   * @param {() => void} [options.onLimit]  appelée quand une fenêtre de plus est refusée
   * @param {(command: string) => string} [options.hint]  raccourci clavier d'une commande, affiché dans le menu
   *        de la fenêtre (voir shell/shortcuts.js)
   */
  constructor(layer, { getAnchorRect, menus = null, placement = null, onLimit = () => {}, hint = () => '' }) {
    super();
    this.#layer = layer;
    this.#getAnchorRect = getAnchorRect;
    this.#menus = menus;
    this.#placement = placement;
    this.#onLimit = onLimit;
    this.#hint = hint;

    this.#preview = document.createElement('div');
    this.#preview.className = 'snap-preview';
    this.#preview.setAttribute('aria-hidden', 'true');
    this.#preview.hidden = true;
    layer.append(this.#preview);

    // Un appui dans une fenêtre la place au premier plan.
    layer.addEventListener(
      'pointerdown',
      (event) => {
        const win = this.#windowAt(event.target);
        if (win) this.focus(win);
      },
      true,
    );

    // Le clavier entre dans une fenêtre (Tab, lecteur d'écran…) : elle devient la fenêtre active.
    layer.addEventListener('focusin', (event) => {
      const win = this.#windowAt(event.target);
      if (win && !win.minimized && this.active !== win) this.focus(win);
    });

    // Tab ne quitte pas la fenêtre active : il y tourne, comme dans une fenêtre de Windows.
    layer.addEventListener('keydown', (event) => this.#containTab(event));

    window.addEventListener('resize', () => {
      this.showSnapPreview(null);
      for (const win of this.#byId.values()) win.fit();
    });
  }

  // --- État -------------------------------------------------------------------

  /** Fenêtres ouvertes (copie), dans l'ordre d'ouverture. */
  get windows() {
    return [...this.#byId.values()];
  }

  /** Fenêtres ouvertes, de la plus récemment utilisée à la plus ancienne (fenêtres réduites comprises). */
  get recent() {
    return this.#stack.recent.map((id) => this.#byId.get(id));
  }

  /** Fenêtre active (au premier plan et non réduite), ou `null`. */
  get active() {
    return this.#byId.get(this.#stack.active) ?? null;
  }

  /** Vrai tant que « afficher le bureau » peut rétablir les fenêtres qu'il a réduites. */
  get desktopShown() {
    return this.#stack.desktopShown;
  }

  /** Fenêtre désignée par son identifiant, ou `null`. */
  get(id) {
    return this.#byId.get(id) ?? null;
  }

  /** Fenêtres d'une application, dans l'ordre d'ouverture. */
  windowsOf(appId) {
    return this.windows.filter((win) => win.app.id === appId);
  }

  /** Fenêtre d'une application utilisée le plus récemment, ou `null`. */
  find(appId) {
    return this.recent.find((win) => win.app.id === appId) ?? null;
  }

  /** Zone de travail : tout l'écran sauf la bande de la barre des tâches. */
  workArea() {
    return { w: this.#layer.clientWidth, h: this.#layer.clientHeight };
  }

  /** Rectangle de l'icône de la barre des tâches (cible des animations). */
  anchorRect(appId) {
    return this.#getAnchorRect(appId);
  }

  // --- Ouverture ----------------------------------------------------------------

  /**
   * Ouvre l'application dans une fenêtre, ou réactive sa fenêtre la plus récente.
   * @param {object} app  définition issue du registre (data/apps.js)
   * @param {object} options
   * @param {(win: AppWindow, params: any) => object|void} options.mount  construit le contenu
   * @param {any} [options.params]     paramètres transmis à l'application
   * @param {DOMRect} [options.origin] icône d'où « sort » la fenêtre
   * @param {boolean} [options.newWindow]  ouvrir une fenêtre de plus, si l'application en admet plusieurs
   * @returns {AppWindow|null} `null` si la fenêtre n'a pas pu être ouverte (trop de fenêtres)
   */
  open(app, { mount, params, origin, newWindow = false } = {}) {
    const existing = this.find(app.id);
    if (existing && !(newWindow && app.multiWindow)) {
      this.activate(existing);
      if (params !== undefined) existing.controller?.onParams?.(params);
      return existing;
    }
    if (this.#stack.size >= MAX_WINDOWS) {
      this.#onLimit();
      if (existing) this.activate(existing);
      return null;
    }

    const size = { ...DEFAULT_SIZE, ...app.size };
    const area = this.workArea();
    const minW = Math.min(rem(size.minW), area.w);
    const minH = Math.min(rem(size.minH), area.h);
    const { rect, maximized } = this.#initialPlacement(app, existing, { w: rem(size.w), h: rem(size.h) }, area, { minW, minH });

    this.#sequence += 1;
    const win = new AppWindow(this, { id: `window-${this.#sequence}`, app, title: app.name, rect, minW, minH, maximized });

    this.#byId.set(win.id, win);
    this.#stack.add(win.id);
    this.#layer.append(win.el);
    try {
      win.controller = mount?.(win, params) ?? null;
    } catch (error) {
      // Une application qui ne démarre pas ne laisse pas de fenêtre vide derrière elle.
      this.#byId.delete(win.id);
      this.#stack.remove(win.id);
      win.el.remove();
      throw error;
    }
    this.focus(win, { content: true });
    win.playOpen(origin);
    return win;
  }

  /**
   * Emplacement d'une nouvelle fenêtre : en cascade par rapport à la fenêtre
   * précédente de l'application ; sinon l'emplacement retenu de la dernière
   * session ; sinon centrée.
   */
  #initialPlacement(app, previous, size, area, limits) {
    if (previous) {
      const rect = cascadeRect(previous.freeRect, area, { stepX: rem(1.75), stepY: rem(1.5) });
      return { rect: fitRectToArea(rect, area, limits), maximized: false };
    }
    let saved = null;
    try {
      saved = this.#placement?.load(app.id) ?? null;
    } catch {
      saved = null;
    }
    // Retenu sur un écran peut-être plus grand : la fenêtre est ramenée, entière, dans celui-ci.
    if (saved && isRect(saved.rect)) return { rect: fitRectToArea(saved.rect, area, limits), maximized: saved.maximized === true };
    return { rect: centeredRect(area, size, { margin: rem(1) }), maximized: false };
  }

  // --- Activation, réduction, fermeture -------------------------------------------

  /**
   * Place une fenêtre au premier plan : elle devient la fenêtre active.
   * @param {AppWindow} win
   * @param {{ content?: boolean }} [options]  `content` : donner aussi le clavier à son contenu
   *        (activation au clavier, ouverture) plutôt qu'à son seul cadre
   */
  focus(win, { content = false } = {}) {
    if (!win || win.closing || win.minimized || !this.#byId.has(win.id)) return;
    if (this.#stack.active !== win.id) {
      this.#stack.activate(win.id);
      this.#apply();
      this.notify();
    }
    if (content) win.focusContent();
    else if (!win.el.contains(document.activeElement)) win.el.focus({ preventScroll: true });
  }

  /** Active une fenêtre, en la rétablissant si elle était réduite, et lui donne le clavier. */
  activate(win) {
    if (!win || win.closing || !this.#byId.has(win.id)) return;
    const wasMinimized = win.minimized;
    this.#stack.activate(win.id);
    if (wasMinimized) win.playRestore();
    this.#apply();
    this.notify();
    win.focusContent();
  }

  /** Retire le focus de toutes les fenêtres (clic sur le bureau). */
  blurAll() {
    if (!this.#stack.active) return;
    this.#stack.deactivate();
    this.#apply();
    this.notify();
  }

  /** Réduit une fenêtre dans la barre des tâches ; la fenêtre utilisée juste avant devient active. */
  minimize(win) {
    if (!win || win.closing || win.minimized || !this.#byId.has(win.id)) return;
    const hadKeyboard = win.el.contains(document.activeElement);
    const next = this.#byId.get(this.#stack.minimize(win.id)) ?? null;
    win.playMinimize();
    this.#apply();
    this.notify();
    if (next) next.focusContent();
    else if (hadKeyboard) document.activeElement?.blur?.();
  }

  /** Ferme une fenêtre ; la fenêtre utilisée juste avant devient active. */
  close(win) {
    if (!win || win.closing || !this.#byId.has(win.id)) return;
    const wasActive = this.#stack.active === win.id;
    this.#byId.delete(win.id);
    const next = this.#byId.get(this.#stack.remove(win.id)) ?? null;
    if (this.#previewZone) this.showSnapPreview(null);
    win.setFocused(false);
    win.playClose();
    this.#apply();
    this.notify();
    if (wasActive && next) next.focusContent();
  }

  /**
   * Comportement d'un clic sur l'icône d'une application qui n'a qu'une
   * fenêtre : la réduire si elle est active, sinon la rétablir et l'activer.
   * @returns {boolean} faux si l'application n'a pas de fenêtre
   */
  toggle(appId) {
    const win = this.find(appId);
    if (!win) return false;
    if (!win.minimized && this.active === win) this.minimize(win);
    else this.activate(win);
    return true;
  }

  /**
   * Affiche le bureau : toutes les fenêtres visibles sont réduites d'un geste.
   * Le même geste les rétablit, tant qu'aucune fenêtre n'a été touchée depuis.
   * @returns {'hide'|'show'|'none'} ce que le geste a fait
   */
  toggleDesktop() {
    const hadKeyboard = this.#layer.contains(document.activeElement);
    const { action, ids } = this.#stack.toggleDesktop();
    if (action === 'none') return action;
    for (const id of ids) {
      const win = this.#byId.get(id);
      if (action === 'hide') win.playMinimize();
      else win.playRestore();
    }
    this.#apply();
    this.notify();
    if (action === 'show') this.active?.focusContent();
    else if (hadKeyboard) document.activeElement?.blur?.();
    return action;
  }

  // --- Limites de l'écran et ancrage (appelés par les fenêtres) ------------------------

  #keepVisible() {
    return { keepLeft: rem(12.5), keepRight: rem(6), titlebar: rem(2.625) };
  }

  /** Limite la position pour que la barre de titre reste toujours accessible. */
  clampPosition(x, y, win) {
    return clampWindowPosition({ x, y, w: win.rect.w }, this.workArea(), this.#keepVisible());
  }

  /** Ramène un rectangle dans la zone de travail (changement de résolution). */
  fitRect(rect, win) {
    return fitRectToArea(rect, this.workArea(), { minW: win?.minW ?? 0, minH: win?.minH ?? 0 });
  }

  /** Disposition libre retrouvée telle que l'utilisateur l'avait laissée, barre de titre à portée. */
  reachRect(rect, win) {
    return reachableRect(rect, this.workArea(), { minW: win?.minW ?? 0, minH: win?.minH ?? 0, ...this.#keepVisible() });
  }

  /** Vrai si la fenêtre peut être ancrée de ce côté : la moitié de l'écran lui suffit. */
  canSnap(win, side) {
    const rect = snapRect(this.workArea(), side);
    return Boolean(rect) && (side === 'top' || rect.w >= win.minW);
  }

  /** Rectangle d'une fenêtre ancrée de ce côté. */
  snapRectFor(_win, side) {
    return snapRect(this.workArea(), side);
  }

  /**
   * Disposition que propose la position du pointeur pendant un déplacement :
   * « left », « right » (moitié de l'écran), « top » (agrandie), ou `null`.
   * @param {AppWindow} win
   * @param {{ x: number, y: number }} point  position du pointeur dans la page
   */
  snapZoneFor(win, point) {
    const box = this.#layer.getBoundingClientRect();
    const zone = snapZoneAt({ x: point.x - box.left, y: point.y - box.top }, this.workArea(), { edge: rem(0.75) });
    return zone && this.canSnap(win, zone) ? zone : null;
  }

  /** Montre (ou retire, avec `null`) l'aperçu de la disposition proposée, juste sous la fenêtre déplacée. */
  showSnapPreview(zone, win = null) {
    if (zone === this.#previewZone) return;
    this.#previewZone = zone;
    const rect = zone ? snapRect(this.workArea(), zone) : null;
    if (!rect) {
      this.#preview.classList.remove('is-visible');
      this.#preview.hidden = true;
      return;
    }
    const style = this.#preview.style;
    style.translate = `${rect.x}px ${rect.y}px`;
    style.width = `${rect.w}px`;
    style.height = `${rect.h}px`;
    // Même rang que la fenêtre déplacée : placé avant elle dans la page, l'aperçu passe juste dessous.
    style.zIndex = win?.el.style.zIndex || String(BASE_Z);
    this.#preview.hidden = false;
    void this.#preview.offsetWidth; // l'apparition est animée
    this.#preview.classList.add('is-visible');
  }

  /** Retient l'emplacement de la fenêtre, pour la prochaine ouverture de son application. */
  rememberPlacement(win) {
    if (!this.#placement || win.closing) return;
    try {
      this.#placement.save(win.app.id, { rect: win.freeRect, maximized: win.maximized });
    } catch {
      /* l'emplacement n'est qu'une commodité : son enregistrement ne doit rien empêcher */
    }
  }

  // --- Menu de la fenêtre ---------------------------------------------------------------

  /**
   * Commandes d'une fenêtre, pour un menu : restaurer, réduire, agrandir,
   * ancrer, fermer. Une commande sans objet reste visible, désactivée.
   * @param {AppWindow} win
   */
  windowMenuItems(win) {
    const hint = this.#hint;
    const free = !win.maximized && !win.snap;
    const snap = (side, label) => ({
      label,
      glyph: 'square-half',
      hint: hint(`window-snap-${side}`),
      checked: win.snap === side ? true : undefined,
      disabled: win.minimized || (win.snap !== side && !this.canSnap(win, side)),
      onSelect: () => {
        this.activate(win);
        if (win.snap === side) win.restoreLayout();
        else win.snapTo(side);
      },
    });
    return [
      {
        label: 'Restaurer',
        glyph: 'corners-in',
        hint: win.minimized ? '' : hint('window-restore'),
        disabled: free && !win.minimized,
        onSelect: () => {
          const wasMinimized = win.minimized;
          this.activate(win);
          if (!wasMinimized) win.restoreLayout();
        },
      },
      { label: 'Réduire', glyph: 'minus', disabled: win.minimized, onSelect: () => this.minimize(win) },
      {
        label: 'Agrandir',
        glyph: 'corners-out',
        hint: hint('window-maximize'),
        disabled: win.maximized && !win.minimized,
        onSelect: () => {
          this.activate(win);
          win.maximize();
        },
      },
      { separator: true },
      snap('left', 'Ancrer à gauche'),
      snap('right', 'Ancrer à droite'),
      { separator: true },
      { label: 'Fermer', glyph: 'x', hint: hint('close-window'), danger: true, onSelect: () => this.close(win) },
    ];
  }

  /** Ouvre le menu d'une fenêtre : à la position donnée, ou sous l'élément `anchor`. */
  showWindowMenu(win, { x = 0, y = 0, anchor = null } = {}) {
    if (!this.#menus || win.closing) return;
    this.focus(win);
    this.#menus.show({ x, y, anchor, label: win.title, items: [{ header: win.title }, ...this.windowMenuItems(win)] });
  }

  /** Signale un changement (regroupé : un seul événement par image). */
  notify() {
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      this.emit('change', { windows: this.windows, active: this.active });
    });
  }

  // --- Interne --------------------------------------------------------------------------

  #windowAt(node) {
    const el = node instanceof Element ? node.closest('.window') : null;
    if (!el) return null;
    for (const win of this.#byId.values()) if (win.el === el) return win;
    return null;
  }

  /** Applique l'empilement et la fenêtre active à l'affichage. */
  #apply() {
    const active = this.#stack.active;
    this.#stack.order.forEach((id, index) => {
      const win = this.#byId.get(id);
      if (!win) return;
      win.el.style.zIndex = String(BASE_Z + index);
      win.setFocused(id === active);
    });
  }

  #containTab(event) {
    if (event.key !== 'Tab' || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
    const win = this.active;
    if (!win || !win.el.contains(event.target)) return;
    const stops = tabStops(win.el);
    if (stops.length === 0) {
      event.preventDefault();
      return;
    }
    const current = document.activeElement;
    const first = stops[0];
    const last = stops.at(-1);
    if (event.shiftKey && (current === first || current === win.el)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }
}
