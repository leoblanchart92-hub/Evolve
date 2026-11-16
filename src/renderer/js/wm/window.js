/**
 * Evolve — Fenêtre personnalisée (verre dépoli).
 *
 * Gère le cadre d'une fenêtre : barre de titre, déplacement, redimensionnement
 * par les huit poignées, agrandissement, ancrage sur une moitié de l'écran,
 * réduction et fermeture animés.
 *
 * Une fenêtre a trois dispositions : libre (position et taille choisies par
 * l'utilisateur), agrandie (toute la zone de travail) ou ancrée (une moitié
 * de la zone de travail). Quitter l'une des deux dernières lui rend sa
 * disposition libre précédente.
 *
 * La position utilise la propriété CSS `translate` (accélérée par le GPU) ;
 * `transform` reste ainsi libre pour les animations d'ouverture/fermeture.
 *
 * L'ordre des fenêtres, la fenêtre active et le clavier sont tenus par le
 * gestionnaire de fenêtres (window-manager.js) : la fenêtre lui demande d'être
 * réduite, activée ou fermée, et ne décide jamais seule de ce qui la remplace
 * au premier plan.
 */

import { h, animate } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { detachedRect, resizedRect } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RESIZE_DIRECTIONS = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'];
const DRAG_THRESHOLD = 4; // px avant de considérer qu'un glissement a commencé
/** Durée de la transition de géométrie (voir .is-morphing, windows.css). */
const MORPH_MS = 360;

const CONTROL_GLYPHS = {
  min: '<path d="M2.25 6h7.5"/>',
  max: '<rect x="2.1" y="2.1" width="7.8" height="7.8" rx="1.7"/>',
  restore:
    '<path d="M4.3 3.7v-.3c0-.9.7-1.6 1.6-1.6h2.7c.9 0 1.6.7 1.6 1.6v2.7c0 .9-.7 1.6-1.6 1.6h-.3"/>' +
    '<rect x="1.8" y="3.7" width="6.5" height="6.5" rx="1.6"/>',
  close: '<path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/>',
};

function controlGlyph(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'window__glyph');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = CONTROL_GLYPHS[kind];
  return svg;
}

/** Vrai si l'élément peut recevoir le clavier : visible, actif, et relié à la page. */
function canFocus(node) {
  return Boolean(node) && node.isConnected && !node.disabled && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0;
}

export class AppWindow {
  /** @type {{ x: number, y: number, w: number, h: number }} rectangle affiché (hors fenêtre agrandie) */
  rect;
  maximized = false;
  /** Moitié de l'écran sur laquelle la fenêtre est ancrée : « left », « right », ou `null`. */
  snap = null;
  minimized = false;
  closing = false;
  /** Contrôleur renvoyé par l'application montée dans la fenêtre. */
  controller = null;
  /** Dernier élément de la fenêtre à avoir eu le clavier : il le retrouve quand la fenêtre redevient active. */
  lastFocused = null;

  #manager;
  /** Disposition libre à retrouver en quittant l'agrandissement ou l'ancrage. */
  #restoreRect = null;
  #frame = 0;
  #morphTimer = 0;
  #maxButton;
  #titleText;
  /** Geste en cours (déplacement ou redimensionnement) : fonction qui l'abandonne, ou `null`. */
  #abortGesture = null;

  /**
   * @param {import('./window-manager.js').WindowManager} manager
   * @param {{ id: string, app: object, title: string, rect: object, minW: number, minH: number, maximized?: boolean }} options
   */
  constructor(manager, { id, app, title, rect, minW, minH, maximized = false }) {
    this.#manager = manager;
    this.id = id;
    this.app = app;
    this.title = title;
    this.rect = { ...rect };
    this.minW = minW;
    this.minH = minH;

    this.#titleText = h('span', { class: 'window__title-text truncate', text: title });
    this.#maxButton = this.#control('max', 'Agrandir', () => this.toggleMaximize());

    // Comme sous Windows, l'icône de la barre de titre ouvre le menu de la fenêtre.
    const menuButton = h(
      'button',
      { class: 'window__menu', type: 'button', 'aria-label': 'Menu de la fenêtre', 'aria-haspopup': 'menu', 'data-tip': 'Menu de la fenêtre' },
      h('span', { class: 'app-icon', style: { '--g1': app.colors[0], '--g2': app.colors[1] } }, icon(app.glyph, 'fill')),
    );
    menuButton.addEventListener('click', () => {
      const box = menuButton.getBoundingClientRect();
      this.#manager.showWindowMenu(this, { anchor: menuButton, x: box.left, y: box.bottom });
    });
    menuButton.addEventListener('dblclick', (event) => event.stopPropagation());

    this.titlebar = h(
      'header',
      { class: 'window__titlebar' },
      h('div', { class: 'window__title' }, menuButton, this.#titleText),
      h(
        'div',
        { class: 'window__controls' },
        this.#control('min', 'Réduire', () => this.minimize()),
        this.#maxButton,
        this.#control('close', 'Fermer', () => this.close()),
      ),
    );

    this.body = h('div', { class: 'window__body' });

    this.el = h(
      'section',
      {
        class: 'window glass',
        role: 'dialog',
        'aria-label': title,
        tabindex: '-1',
        dataset: { app: app.id, window: id },
      },
      this.titlebar,
      this.body,
      RESIZE_DIRECTIONS.map((dir) => {
        const handle = h('div', { class: 'window__resize', dataset: { dir } });
        handle.addEventListener('pointerdown', (event) => this.#startResize(event, dir, handle));
        return handle;
      }),
    );

    this.titlebar.addEventListener('pointerdown', (event) => this.#startDrag(event));
    this.titlebar.addEventListener('dblclick', (event) => {
      if (event.target.closest('.window__controls, .window__menu')) return;
      this.toggleMaximize();
    });
    // Clic droit sur la barre de titre : menu de la fenêtre, comme sous Windows.
    this.titlebar.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target.closest('.window__controls')) return;
      this.#manager.showWindowMenu(this, { x: event.clientX, y: event.clientY });
    });
    this.el.addEventListener('focusin', (event) => {
      if (event.target !== this.el) this.lastFocused = event.target;
    });

    if (maximized) {
      // Ouverte agrandie (emplacement retenu) : `rect` est la disposition libre à retrouver.
      this.#restoreRect = { ...this.rect };
      this.maximized = true;
      this.el.classList.add('is-maximized');
      this.#syncMaxButton();
    }
    this.#applyRect();
  }

  // --- État -------------------------------------------------------------------

  /** Disposition libre de la fenêtre : celle qu'elle a, ou qu'elle retrouvera en quittant l'agrandissement ou l'ancrage. */
  get freeRect() {
    return { ...(this.#restoreRect ?? this.rect) };
  }

  /** Vrai pendant un déplacement ou un redimensionnement à la souris. */
  get busy() {
    return this.#abortGesture !== null;
  }

  // --- API publique ---------------------------------------------------------

  setTitle(title) {
    this.title = title;
    this.#titleText.textContent = title;
    this.el.setAttribute('aria-label', title);
    this.#manager.notify();
  }

  /** Adapte la fenêtre à une nouvelle taille d'écran. */
  fit() {
    this.#abortGesture?.();
    if (this.#restoreRect) this.#restoreRect = this.#manager.fitRect(this.#restoreRect, this);
    if (this.maximized) return;
    this.rect = this.snap ? this.#manager.snapRectFor(this, this.snap) : this.#manager.fitRect(this.rect, this);
    this.#applyRect();
  }

  /** Agrandit la fenêtre, ou lui rend sa disposition précédente. */
  toggleMaximize() {
    this.#setLayout({ maximized: !this.maximized, snap: null });
    this.#manager.focus(this);
  }

  /** Agrandit la fenêtre sur toute la zone de travail. */
  maximize() {
    this.#setLayout({ maximized: true, snap: null });
  }

  /** Rend à la fenêtre sa disposition libre (ni agrandie, ni ancrée). */
  restoreLayout() {
    this.#setLayout({ maximized: false, snap: null });
  }

  /**
   * Ancre la fenêtre sur une moitié de la zone de travail.
   * @param {'left'|'right'} side
   * @returns {boolean} faux si l'écran est trop étroit pour cette fenêtre
   */
  snapTo(side) {
    if (!this.#manager.canSnap(this, side)) return false;
    this.#setLayout({ maximized: false, snap: side });
    return true;
  }

  /** Réduit la fenêtre dans la barre des tâches. */
  minimize() {
    this.#manager.minimize(this);
  }

  /** Ferme la fenêtre. */
  close() {
    this.#manager.close(this);
  }

  setFocused(focused) {
    this.el.classList.toggle('is-focused', focused);
  }

  /**
   * Donne le clavier au contenu de la fenêtre : à l'élément qui l'avait en
   * dernier, sinon à celui que l'application désigne, sinon au cadre.
   */
  focusContent() {
    if (this.minimized || this.closing) return;
    if (this.el.contains(document.activeElement) && document.activeElement !== this.el) return;
    if (canFocus(this.lastFocused) && this.el.contains(this.lastFocused)) {
      this.lastFocused.focus({ preventScroll: true });
      return;
    }
    if (this.controller?.focusDefault?.() === true) return;
    this.el.focus({ preventScroll: true });
  }

  // --- Animations (appelées par le gestionnaire de fenêtres) -------------------

  /** Animation d'ouverture ; `origin` (DOMRect) fait « sortir » la fenêtre de l'icône cliquée. */
  async playOpen(origin) {
    await animate(this.el, [{ opacity: 0, transform: this.#transformTowards(origin, 0.3) }, { opacity: 1, transform: 'none' }], {
      duration: origin ? 380 : 320,
    });
  }

  /** Réduit la fenêtre vers son icône de la barre des tâches. */
  async playMinimize() {
    if (this.minimized || this.closing) return;
    this.#abortGesture?.();
    this.minimized = true;
    // Pendant qu'elle s'efface, la fenêtre ne reçoit plus ni clic ni clavier.
    this.el.inert = true;
    const anchor = this.#manager.anchorRect(this.app.id);
    await animate(
      this.el,
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: this.#transformTowards(anchor, 0.12) },
      ],
      { duration: 280, easing: 'cubic-bezier(0.5, 0, 0.75, 0.3)', fill: 'forwards' },
    );
    if (this.minimized) this.el.hidden = true;
    this.#clearAnimations();
  }

  /** Rétablit une fenêtre réduite. */
  async playRestore() {
    if (!this.minimized || this.closing) return;
    this.minimized = false;
    this.el.hidden = false;
    this.el.inert = false;
    this.#clearAnimations({ all: true });
    const anchor = this.#manager.anchorRect(this.app.id);
    await animate(
      this.el,
      [
        { opacity: 0, transform: this.#transformTowards(anchor, 0.12) },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 340 },
    );
  }

  /** Fermeture : animation, arrêt de l'application, puis retrait de la page. */
  async playClose() {
    if (this.closing) return;
    this.#abortGesture?.();
    this.closing = true;
    this.el.classList.add('is-closing');
    this.el.inert = true;
    if (!this.minimized) {
      await animate(
        this.el,
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'scale(0.94)' },
        ],
        { duration: 190, easing: 'cubic-bezier(0.5, 0, 0.75, 0.3)', fill: 'forwards' },
      );
    }
    try {
      this.controller?.destroy?.();
    } finally {
      cancelAnimationFrame(this.#frame);
      clearTimeout(this.#morphTimer);
      this.el.remove();
    }
  }

  // --- Interne ---------------------------------------------------------------

  #control(kind, label, onClick) {
    const button = h(
      'button',
      { class: `window__control window__control--${kind}`, type: 'button', 'aria-label': label, 'data-tip': label },
      controlGlyph(kind),
    );
    button.addEventListener('click', onClick);
    // Un double-clic sur un bouton ne doit pas agrandir la fenêtre.
    button.addEventListener('dblclick', (event) => event.stopPropagation());
    return button;
  }

  #applyRect() {
    const { x, y, w, h: height } = this.rect;
    this.el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
    this.el.style.width = `${Math.round(w)}px`;
    this.el.style.height = `${Math.round(height)}px`;
  }

  /** Applique la géométrie à la prochaine image (une seule écriture par image). */
  #scheduleApply() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#applyRect();
    });
  }

  /** Fin d'un geste : la géométrie en attente est affichée tout de suite, sans attendre l'image suivante. */
  #flushRect() {
    if (!this.#frame) return;
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#applyRect();
  }

  #clearAnimations({ all = false } = {}) {
    for (const animation of this.el.getAnimations()) {
      // Seules les animations de la fenêtre elle-même : celles de son contenu ne sont pas touchées.
      if (animation.effect?.target !== this.el) continue;
      if (all || animation.playState === 'finished') animation.cancel();
    }
  }

  /** Transformation qui amène visuellement la fenêtre vers un rectangle cible. */
  #transformTowards(target, scale) {
    if (!target) return 'translateY(0.875rem) scale(0.95)';
    const box = this.el.getBoundingClientRect();
    const dx = target.left + target.width / 2 - (box.left + box.width / 2);
    const dy = target.top + target.height / 2 - (box.top + box.height / 2);
    return `translate(${Math.round(dx)}px, ${Math.round(dy)}px) scale(${scale})`;
  }

  #syncMaxButton() {
    const label = this.maximized ? 'Restaurer' : 'Agrandir';
    this.#maxButton.setAttribute('aria-label', label);
    this.#maxButton.dataset.tip = label;
    this.#maxButton.replaceChildren(controlGlyph(this.maximized ? 'restore' : 'max'));
  }

  /**
   * Change la disposition de la fenêtre.
   * @param {{ maximized: boolean, snap: 'left'|'right'|null }} next
   * @param {{ animate?: boolean, restoreTo?: object|null }} [options]
   *        `restoreTo` : disposition libre à retenir (par défaut, celle que la fenêtre quitte)
   */
  #setLayout({ maximized, snap }, { animate: animated = true, restoreTo = null } = {}) {
    const side = maximized ? null : snap;
    if (maximized === this.maximized && side === this.snap) return;
    this.#abortGesture?.();
    const wasFree = !this.maximized && !this.snap;
    if (restoreTo) this.#restoreRect = { ...restoreTo };
    else if (wasFree) this.#restoreRect = { ...this.rect };
    this.maximized = maximized;
    this.snap = side;

    // Transition de géométrie le temps du changement d'état.
    clearTimeout(this.#morphTimer);
    if (animated) {
      this.el.classList.add('is-morphing');
      this.#morphTimer = setTimeout(() => this.el.classList.remove('is-morphing'), MORPH_MS);
    } else {
      this.el.classList.remove('is-morphing');
    }

    this.el.classList.toggle('is-maximized', maximized);
    this.el.classList.toggle('is-snapped', side !== null);
    if (side) this.el.dataset.snap = side;
    else delete this.el.dataset.snap;

    if (side) {
      this.rect = this.#manager.snapRectFor(this, side);
      this.#applyRect();
    } else if (!maximized) {
      // La fenêtre revient où l'utilisateur l'avait laissée, même en partie hors de l'écran.
      this.rect = this.#manager.reachRect(this.#restoreRect ?? this.rect, this);
      this.#restoreRect = null;
      this.#applyRect();
    }

    this.#syncMaxButton();
    this.#manager.notify();
    this.#manager.rememberPlacement(this);
  }

  /**
   * Suit un geste du pointeur commencé sur `target` : `onMove` à chaque
   * déplacement, `onEnd(committed)` à la fin — `committed` est faux si le
   * geste est abandonné (touche Échap, fenêtre de Windows passée devant,
   * pointeur perdu avant d'être relâché).
   */
  #track(event, target, { onMove, onEnd }) {
    let done = false;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* pointeur inconnu du moteur (événement fabriqué) : le geste est suivi sans capture */
    }
    const finish = (committed) => {
      if (done) return;
      done = true;
      this.#abortGesture = null;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      target.removeEventListener('lostpointercapture', lost);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        /* capture déjà rendue */
      }
      onEnd(committed);
    };
    // Un second doigt ou un second pointeur ne dérange pas le geste en cours.
    const own = (other) => other.pointerId === event.pointerId;
    const move = (other) => {
      if (own(other)) onMove(other);
    };
    const up = (other) => {
      if (own(other)) finish(true);
    };
    const cancel = () => finish(false);
    // Capture perdue sans relâchement : le pointeur n'est plus suivi, le geste s'arrête où il en est.
    const lost = (other) => {
      if (own(other)) finish(true);
    };
    const key = (other) => {
      if (other.key !== 'Escape') return;
      other.preventDefault();
      other.stopPropagation();
      finish(false);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', cancel);
    target.addEventListener('lostpointercapture', lost);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    this.#abortGesture = () => finish(false);
  }

  // --- Déplacement -----------------------------------------------------------

  #startDrag(event) {
    if (event.button !== 0 || event.isPrimary === false || this.busy || this.closing) return;
    if (event.target.closest('.window__controls, .window__menu')) return;

    // État au début du geste : Échap le rétablit tel quel.
    const origin = { rect: { ...this.rect }, maximized: this.maximized, snap: this.snap, restoreRect: this.#restoreRect && { ...this.#restoreRect } };
    const start = { px: event.clientX, py: event.clientY, x: this.rect.x, y: this.rect.y, moving: false };
    let zone = null;

    this.#track(event, this.titlebar, {
      onMove: (move) => {
        const dx = move.clientX - start.px;
        const dy = move.clientY - start.py;

        if (!start.moving) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          start.moving = true;

          if (this.maximized || this.snap) {
            // Glisser une fenêtre agrandie ou ancrée lui rend sa taille libre, sous le pointeur.
            const area = this.#manager.workArea();
            const from = this.maximized ? { x: 0, y: 0, w: area.w, h: area.h } : this.rect;
            const size = this.#restoreRect ?? this.rect;
            clearTimeout(this.#morphTimer);
            this.el.classList.remove('is-morphing', 'is-maximized', 'is-snapped');
            delete this.el.dataset.snap;
            this.maximized = false;
            this.snap = null;
            this.#restoreRect = null;
            this.rect = detachedRect({ x: start.px, y: start.py }, from, size);
            this.#syncMaxButton();
            this.#manager.notify();
            start.x = this.rect.x;
            start.y = this.rect.y;
          }

          this.el.classList.add('is-dragging');
          document.body.classList.add('is-window-dragging');
        }

        const next = this.#manager.clampPosition(start.x + dx, start.y + dy, this);
        this.rect.x = next.x;
        this.rect.y = next.y;
        this.#scheduleApply();

        // Près d'un bord de l'écran : la disposition proposée est montrée avant d'être appliquée.
        zone = this.#manager.snapZoneFor(this, { x: move.clientX, y: move.clientY });
        this.#manager.showSnapPreview(zone, this);
      },
      onEnd: (committed) => {
        this.el.classList.remove('is-dragging');
        document.body.classList.remove('is-window-dragging');
        this.#manager.showSnapPreview(null, this);
        if (!start.moving) return;
        if (!committed) {
          this.#restore(origin);
          return;
        }
        this.#flushRect();
        // Disposition libre à retrouver plus tard : celle d'avant le geste, et non la position du lâcher.
        const free = origin.restoreRect ?? origin.rect;
        if (zone === 'top') this.#setLayout({ maximized: true, snap: null }, { restoreTo: free });
        else if (zone) this.#setLayout({ maximized: false, snap: zone }, { restoreTo: free });
        else this.#manager.rememberPlacement(this);
      },
    });
  }

  /** Rétablit l'état qu'avait la fenêtre au début d'un geste abandonné. */
  #restore({ rect, maximized, snap, restoreRect }) {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.rect = { ...rect };
    this.maximized = maximized;
    this.snap = snap;
    this.#restoreRect = restoreRect ? { ...restoreRect } : null;
    this.el.classList.toggle('is-maximized', maximized);
    this.el.classList.toggle('is-snapped', snap !== null);
    if (snap) this.el.dataset.snap = snap;
    else delete this.el.dataset.snap;
    this.#applyRect();
    this.#syncMaxButton();
    this.#manager.notify();
  }

  // --- Redimensionnement -----------------------------------------------------

  #startResize(event, dir, handle) {
    if (event.button !== 0 || event.isPrimary === false || this.maximized || this.busy || this.closing) return;
    event.preventDefault();
    event.stopPropagation();
    this.#manager.focus(this);

    const origin = { rect: { ...this.rect }, maximized: false, snap: this.snap, restoreRect: this.#restoreRect && { ...this.#restoreRect } };
    const start = { px: event.clientX, py: event.clientY, ...this.rect };
    const area = this.#manager.workArea();
    let moved = false;
    this.el.classList.add('is-resizing');
    document.body.dataset.resizing = dir;

    this.#track(event, handle, {
      onMove: (move) => {
        if (!moved) {
          moved = true;
          if (this.snap) {
            // Redimensionner une fenêtre ancrée en fait une fenêtre libre, à la taille qu'elle a.
            this.snap = null;
            this.#restoreRect = null;
            this.el.classList.remove('is-snapped', 'is-morphing');
            delete this.el.dataset.snap;
            this.#manager.notify();
          }
        }
        this.rect = resizedRect(start, dir, move.clientX - start.px, move.clientY - start.py, area, { minW: this.minW, minH: this.minH });
        this.#scheduleApply();
      },
      onEnd: (committed) => {
        this.el.classList.remove('is-resizing');
        delete document.body.dataset.resizing;
        if (!moved) return;
        if (!committed) {
          this.#restore(origin);
          return;
        }
        this.#flushRect();
        this.#manager.rememberPlacement(this);
      },
    });
  }
}
