/**
 * Evolve — Gestionnaire de fenêtres.
 *
 * Crée les fenêtres, gère l'ordre d'empilement, le focus, les limites de
 * l'écran et informe le reste de l'interface (barre des tâches) des changements.
 */

import { rem } from '../core/dom.js';
import { Emitter } from '../core/events.js';
import { AppWindow } from './window.js';
import { centeredRect, fitRectToArea, clampWindowPosition } from './geometry.js';

/** Dimensions par défaut d'une fenêtre, en rem (elles suivent l'échelle de l'interface). */
const DEFAULT_SIZE = Object.freeze({ w: 46, h: 30, minW: 22, minH: 14 });

export class WindowManager extends Emitter {
  #layer;
  #getAnchorRect;
  /** @type {AppWindow[]} dans l'ordre d'ouverture */
  #windows = [];
  /** @type {AppWindow|null} */
  #active = null;
  #z = 10;
  #sequence = 0;
  #notifyQueued = false;

  /**
   * @param {HTMLElement} layer  calque qui contient les fenêtres (zone de travail)
   * @param {{ getAnchorRect: (appId: string) => DOMRect|null }} options
   */
  constructor(layer, { getAnchorRect }) {
    super();
    this.#layer = layer;
    this.#getAnchorRect = getAnchorRect;

    // Un appui dans une fenêtre la place au premier plan.
    layer.addEventListener(
      'pointerdown',
      (event) => {
        const el = event.target instanceof Element ? event.target.closest('.window') : null;
        const win = el && this.#windows.find((candidate) => candidate.el === el);
        if (win) this.focus(win);
      },
      true,
    );

    window.addEventListener('resize', () => {
      for (const win of this.#windows) win.fit();
    });
  }

  /** Fenêtres ouvertes (copie), dans l'ordre d'ouverture. */
  get windows() {
    return [...this.#windows];
  }

  /** Fenêtre active (au premier plan et non réduite), ou `null`. */
  get active() {
    return this.#active;
  }

  /** Fenêtre d'une application, si elle est ouverte. */
  find(appId) {
    return this.#windows.find((win) => win.app.id === appId) ?? null;
  }

  /** Zone de travail : tout l'écran sauf la bande de la barre des tâches. */
  workArea() {
    return { w: this.#layer.clientWidth, h: this.#layer.clientHeight };
  }

  /** Rectangle de l'icône de la barre des tâches (cible des animations). */
  anchorRect(appId) {
    return this.#getAnchorRect(appId);
  }

  /**
   * Ouvre l'application dans une fenêtre, ou réactive sa fenêtre existante.
   * @param {object} app  définition issue du registre (data/apps.js)
   * @param {object} options
   * @param {(win: AppWindow, params: any) => object|void} options.mount  construit le contenu
   * @param {any} [options.params]     paramètres transmis à l'application
   * @param {DOMRect} [options.origin] icône d'où « sort » la fenêtre
   */
  open(app, { mount, params, origin } = {}) {
    const existing = this.find(app.id);
    if (existing) {
      if (existing.minimized) existing.restore();
      this.focus(existing);
      if (params !== undefined) existing.controller?.onParams?.(params);
      return existing;
    }

    const size = { ...DEFAULT_SIZE, ...app.size };
    const area = this.workArea();
    const step = this.#sequence % 6;
    const rect = centeredRect(area, { w: rem(size.w), h: rem(size.h) }, {
      margin: rem(1),
      offsetX: (step - 1) * rem(1.75),
      offsetY: (step - 1) * rem(1.5),
    });

    this.#sequence += 1;
    const win = new AppWindow(this, {
      id: `window-${this.#sequence}`,
      app,
      title: app.name,
      rect,
      minW: Math.min(rem(size.minW), area.w),
      minH: Math.min(rem(size.minH), area.h),
    });

    this.#windows.push(win);
    this.#layer.append(win.el);
    win.controller = mount?.(win, params) ?? null;
    this.focus(win);
    win.playOpen(origin);
    return win;
  }

  /** Place une fenêtre au premier plan. */
  focus(win) {
    if (!win || win.closing) return;
    if (this.#active !== win) {
      this.#z += 1;
      win.el.style.zIndex = String(this.#z);
      this.#active?.setFocused(false);
      this.#active = win;
      win.setFocused(true);
      this.notify();
    }
    if (!win.el.contains(document.activeElement)) win.el.focus({ preventScroll: true });
  }

  /** Retire le focus de toutes les fenêtres (clic sur le bureau). */
  blurAll() {
    if (!this.#active) return;
    this.#active.setFocused(false);
    this.#active = null;
    this.notify();
  }

  /**
   * Comportement d'un clic sur l'icône d'une application dans la barre des
   * tâches : réduire si elle est active, sinon restaurer / activer.
   * @returns {boolean} faux si l'application n'a pas de fenêtre
   */
  toggle(appId) {
    const win = this.find(appId);
    if (!win) return false;
    if (win.minimized) {
      win.restore();
      this.focus(win);
    } else if (this.#active === win) {
      win.minimize();
    } else {
      this.focus(win);
    }
    return true;
  }

  // --- Appelé par les fenêtres ----------------------------------------------

  handleMinimized(win) {
    if (this.#active === win) {
      win.setFocused(false);
      this.#active = null;
      this.#focusTopmost();
    }
    this.notify();
  }

  handleClosing(win) {
    this.#windows = this.#windows.filter((candidate) => candidate !== win);
    if (this.#active === win) {
      this.#active = null;
      this.#focusTopmost();
    }
    this.notify();
  }

  /** Limite la position pour que la barre de titre reste toujours accessible. */
  clampPosition(x, y, win) {
    return clampWindowPosition({ x, y, w: win.rect.w }, this.workArea(), {
      keepLeft: rem(12.5),
      keepRight: rem(6),
      titlebar: rem(2.625),
    });
  }

  /** Ramène un rectangle dans la zone de travail (changement de résolution). */
  fitRect(rect, win) {
    return fitRectToArea(rect, this.workArea(), { minW: win?.minW ?? 0, minH: win?.minH ?? 0 });
  }

  /** Signale un changement (regroupé : un seul événement par image). */
  notify() {
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      this.emit('change', { windows: this.windows, active: this.#active });
    });
  }

  #focusTopmost() {
    const candidates = this.#windows.filter((win) => !win.minimized && !win.closing);
    if (!candidates.length) return;
    const top = candidates.reduce((best, win) =>
      Number(win.el.style.zIndex || 0) > Number(best.el.style.zIndex || 0) ? win : best,
    );
    this.focus(top);
  }
}
