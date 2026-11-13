/**
 * Evolve — Panneaux flottants (menu Démarrer, paramètres rapides,
 * centre de notifications).
 *
 * Un seul panneau est ouvert à la fois. Il se referme par un clic à
 * l'extérieur, par la touche Échap ou en recliquant sur son bouton. À la
 * fermeture, le clavier retourne à l'élément qui l'avait avant l'ouverture —
 * la fenêtre active, le plus souvent.
 */

import { Emitter } from '../core/events.js';

/** Classe de base d'un panneau : ouverture/fermeture animées en CSS (.is-open). */
export class Flyout {
  isOpen = false;

  /**
   * @param {string} name  identifiant ('start', 'quick-settings', 'notifications')
   * @param {HTMLElement} el
   */
  constructor(name, el) {
    this.name = name;
    this.el = el;
    el.classList.add('flyout');
    el.dataset.flyoutPanel = name;
    el.inert = true;
  }

  open(options) {
    if (this.isOpen) {
      this.onReopen?.(options);
      return;
    }
    this.isOpen = true;
    this.el.inert = false;
    this.el.classList.add('is-open');
    this.onOpen?.(options);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.inert = true;
    this.el.classList.remove('is-open');
    this.onClose?.();
  }

  /** Renvoie vrai si la touche Échap a été consommée (le panneau reste ouvert). */
  onEscape() {
    return false;
  }
}

export class FlyoutController extends Emitter {
  /** @type {Map<string, Flyout>} */
  #flyouts = new Map();
  /** @type {Flyout|null} */
  #current = null;
  /** Élément qui avait le clavier avant l'ouverture du premier panneau. */
  #returnFocus = null;
  #restoreFocus;

  /**
   * @param {HTMLElement} layer  calque qui reçoit les panneaux
   * @param {object} options
   * @param {(node: Node) => boolean} options.isMenuTarget  vrai pour un élément du menu ouvert depuis le panneau
   * @param {(previous: Element|null) => void} [options.restoreFocus]  rend le clavier, à la fermeture, à
   *        l'élément qui l'avait avant l'ouverture (`previous`) — ou, à défaut, à qui de droit
   */
  constructor(layer, { isMenuTarget, restoreFocus = () => {} }) {
    super();
    this.layer = layer;
    this.#restoreFocus = restoreFocus;

    document.addEventListener(
      'pointerdown',
      (event) => {
        const current = this.#current;
        if (!current || !(event.target instanceof Element)) return;
        if (current.el.contains(event.target)) return;
        if (isMenuTarget(event.target)) return; // menu ouvert depuis le panneau
        // Le bouton du panneau gère lui-même la bascule.
        const trigger = event.target.closest('[data-flyout]');
        if (trigger?.dataset.flyout === current.name) return;
        this.close();
      },
      true,
    );

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.#current) return;
      event.preventDefault();
      if (!this.#current.onEscape()) this.close();
    });
  }

  /** Nom du panneau ouvert, ou `null`. */
  get current() {
    return this.#current?.name ?? null;
  }

  register(flyout) {
    this.#flyouts.set(flyout.name, flyout);
    this.layer.append(flyout.el);
    return flyout;
  }

  get(name) {
    return this.#flyouts.get(name);
  }

  open(name, options) {
    const flyout = this.#flyouts.get(name);
    if (!flyout) return;
    // Premier panneau ouvert : on retient où était le clavier. D'un panneau à l'autre, ce souvenir est gardé.
    if (!this.#current) this.#returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (this.#current && this.#current !== flyout) this.#current.close();
    this.#current = flyout;
    flyout.open(options);
    this.emit('change', this.current);
  }

  close() {
    if (!this.#current) return;
    const hadKeyboard = this.#current.el.contains(document.activeElement);
    this.#current.close();
    this.#current = null;
    const previous = this.#returnFocus;
    this.#returnFocus = null;
    this.emit('change', null);
    // Le clavier était dans le panneau (ou nulle part) : il retourne où il était avant l'ouverture.
    if (hadKeyboard || !document.activeElement || document.activeElement === document.body) this.#restoreFocus(previous);
  }

  toggle(name, options) {
    if (this.current === name) this.close();
    else this.open(name, options);
  }
}
