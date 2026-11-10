/**
 * Evolve — Fenêtre personnalisée (verre dépoli).
 *
 * Gère le cadre d'une fenêtre : barre de titre, déplacement, redimensionnement
 * par les huit poignées, agrandissement, réduction et fermeture animés.
 *
 * La position utilise la propriété CSS `translate` (accélérée par le GPU) ;
 * `transform` reste ainsi libre pour les animations d'ouverture/fermeture.
 */

import { h, clamp, animate } from '../core/dom.js';
import { icon } from '../core/icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RESIZE_DIRECTIONS = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'];
const DRAG_THRESHOLD = 4; // px avant de considérer qu'un glissement a commencé

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

export class AppWindow {
  /** @type {{ x: number, y: number, w: number, h: number }} */
  rect;
  maximized = false;
  minimized = false;
  closing = false;
  /** Contrôleur renvoyé par l'application montée dans la fenêtre. */
  controller = null;

  #manager;
  #restoreRect = null;
  #frame = 0;
  #morphTimer = 0;
  #maxButton;
  #titleText;

  /**
   * @param {import('./window-manager.js').WindowManager} manager
   * @param {{ id: string, app: object, title: string, rect: object, minW: number, minH: number }} options
   */
  constructor(manager, { id, app, title, rect, minW, minH }) {
    this.#manager = manager;
    this.id = id;
    this.app = app;
    this.title = title;
    this.rect = { ...rect };
    this.minW = minW;
    this.minH = minH;

    this.#titleText = h('span', { class: 'window__title-text truncate', text: title });
    this.#maxButton = this.#control('max', 'Agrandir', () => this.toggleMaximize());

    this.titlebar = h(
      'header',
      { class: 'window__titlebar' },
      h(
        'div',
        { class: 'window__title' },
        h(
          'span',
          { class: 'app-icon', style: { '--g1': app.colors[0], '--g2': app.colors[1] } },
          icon(app.glyph, 'fill'),
        ),
        this.#titleText,
      ),
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
      if (event.target.closest('.window__controls')) return;
      this.toggleMaximize();
    });

    this.#applyRect();
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
    if (this.maximized) {
      if (this.#restoreRect) this.#restoreRect = this.#manager.fitRect(this.#restoreRect, this);
      return;
    }
    this.rect = this.#manager.fitRect(this.rect, this);
    this.#applyRect();
  }

  toggleMaximize() {
    this.#setMaximized(!this.maximized);
    this.#manager.focus(this);
  }

  /** Animation d'ouverture ; `origin` (DOMRect) fait « sortir » la fenêtre de l'icône cliquée. */
  async playOpen(origin) {
    await animate(this.el, [{ opacity: 0, transform: this.#transformTowards(origin, 0.3) }, { opacity: 1, transform: 'none' }], {
      duration: origin ? 380 : 320,
    });
  }

  /** Réduit la fenêtre vers son icône de la barre des tâches. */
  async minimize() {
    if (this.minimized || this.closing) return;
    this.minimized = true;
    this.#manager.handleMinimized(this);
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

  /** Restaure une fenêtre réduite. */
  async restore() {
    if (!this.minimized || this.closing) return;
    this.minimized = false;
    this.el.hidden = false;
    this.#clearAnimations();
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

  /** Ferme la fenêtre (animation puis retrait du DOM). */
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.el.classList.add('is-closing');
    this.#manager.handleClosing(this);
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

  setFocused(focused) {
    this.el.classList.toggle('is-focused', focused);
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

  #clearAnimations() {
    for (const animation of this.el.getAnimations()) {
      if (animation.playState === 'finished') animation.cancel();
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

  #setMaximized(value) {
    if (value === this.maximized) return;
    if (value) this.#restoreRect = { ...this.rect };
    this.maximized = value;

    // Transition de géométrie le temps du changement d'état.
    this.el.classList.add('is-morphing');
    clearTimeout(this.#morphTimer);
    this.#morphTimer = setTimeout(() => this.el.classList.remove('is-morphing'), 360);

    this.el.classList.toggle('is-maximized', value);
    if (!value && this.#restoreRect) {
      this.rect = this.#manager.fitRect(this.#restoreRect, this);
      this.#applyRect();
    }

    const label = value ? 'Restaurer' : 'Agrandir';
    this.#maxButton.setAttribute('aria-label', label);
    this.#maxButton.dataset.tip = label;
    this.#maxButton.replaceChildren(controlGlyph(value ? 'restore' : 'max'));
    this.#manager.notify();
  }

  // --- Déplacement -----------------------------------------------------------

  #startDrag(event) {
    if (event.button !== 0 || event.target.closest('.window__controls')) return;

    const titlebar = this.titlebar;
    const start = { px: event.clientX, py: event.clientY, x: this.rect.x, y: this.rect.y, moving: false };
    titlebar.setPointerCapture(event.pointerId);

    const onMove = (move) => {
      const dx = move.clientX - start.px;
      const dy = move.clientY - start.py;

      if (!start.moving) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        start.moving = true;

        if (this.maximized) {
          // Glisser une fenêtre agrandie la restaure sous le pointeur.
          const area = this.#manager.workArea();
          const ratio = clamp(start.px / area.w, 0, 1);
          const restored = this.#restoreRect ?? this.rect;
          this.el.classList.remove('is-morphing');
          this.maximized = false;
          this.el.classList.remove('is-maximized');
          this.rect = { ...restored, x: start.px - restored.w * ratio, y: 0 };
          this.#maxButton.setAttribute('aria-label', 'Agrandir');
          this.#maxButton.dataset.tip = 'Agrandir';
          this.#maxButton.replaceChildren(controlGlyph('max'));
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
    };

    const onEnd = () => {
      titlebar.removeEventListener('pointermove', onMove);
      titlebar.removeEventListener('pointerup', onEnd);
      titlebar.removeEventListener('pointercancel', onEnd);
      titlebar.removeEventListener('lostpointercapture', onEnd);
      this.el.classList.remove('is-dragging');
      document.body.classList.remove('is-window-dragging');
    };

    titlebar.addEventListener('pointermove', onMove);
    titlebar.addEventListener('pointerup', onEnd);
    titlebar.addEventListener('pointercancel', onEnd);
    titlebar.addEventListener('lostpointercapture', onEnd);
  }

  // --- Redimensionnement -----------------------------------------------------

  #startResize(event, dir, handle) {
    if (event.button !== 0 || this.maximized) return;
    event.preventDefault();
    event.stopPropagation();
    this.#manager.focus(this);

    const start = { px: event.clientX, py: event.clientY, ...this.rect };
    const area = this.#manager.workArea();
    const maxHeightDown = Math.max(start.h, area.h - start.y);
    handle.setPointerCapture(event.pointerId);
    this.el.classList.add('is-resizing');
    document.body.dataset.resizing = dir;

    const onMove = (move) => {
      const dx = move.clientX - start.px;
      const dy = move.clientY - start.py;
      let { x, y, w, h: height } = start;

      if (dir.includes('e')) w = Math.max(this.minW, start.w + dx);
      if (dir.includes('s')) height = clamp(start.h + dy, this.minH, maxHeightDown);
      if (dir.includes('w')) {
        w = Math.max(this.minW, start.w - dx);
        x = start.x + start.w - w;
      }
      if (dir.includes('n')) {
        // Le bord supérieur ne dépasse jamais le haut de l'écran.
        height = clamp(start.h - dy, this.minH, start.y + start.h);
        y = start.y + start.h - height;
      }

      this.rect = { x, y, w, h: height };
      this.#scheduleApply();
    };

    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      handle.removeEventListener('lostpointercapture', onEnd);
      this.el.classList.remove('is-resizing');
      delete document.body.dataset.resizing;
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
    handle.addEventListener('lostpointercapture', onEnd);
  }
}
