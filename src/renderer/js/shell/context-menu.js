/**
 * Evolve — Menus contextuels et déroulants (verre dépoli, animés, clavier).
 *
 * Élément de menu :
 *   { label, glyph?, hint?, checked?, disabled?, danger?, onSelect? }
 *   { separator: true }
 *   { header: 'Titre de section' }
 */

import { h, clamp, rem } from '../core/dom.js';
import { icon } from '../core/icons.js';

export class MenuLayer {
  #layer;
  #current = null;

  constructor(layer) {
    this.#layer = layer;

    // Clic en dehors du menu : fermeture (sauf sur le bouton qui l'a ouvert,
    // qui gère lui-même la bascule).
    document.addEventListener(
      'pointerdown',
      (event) => {
        const current = this.#current;
        if (!current) return;
        if (current.el.contains(event.target)) return;
        if (current.anchor?.contains(event.target)) return;
        this.close();
      },
      true,
    );

    document.addEventListener('keydown', (event) => this.#onKeyDown(event), true);
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
  }

  get isOpen() {
    return this.#current !== null;
  }

  /** Vrai si l'élément appartient au menu ouvert. */
  contains(node) {
    return this.#current?.el.contains(node) ?? false;
  }

  /**
   * Affiche un menu.
   * @param {object} options
   * @param {Array} options.items
   * @param {number} [options.x]  position du pointeur (menu contextuel)
   * @param {number} [options.y]
   * @param {Element} [options.anchor]  bouton d'origine (menu déroulant) ;
   *        un second appel avec la même ancre referme le menu.
   * @param {'bottom-start'|'bottom-end'|'top-start'|'top-end'} [options.placement]
   * @param {string} [options.label]  nom accessible du menu
   */
  show({ items, x = 0, y = 0, anchor = null, placement = 'bottom-start', label = 'Menu' }) {
    if (anchor && this.#current?.anchor === anchor) {
      this.close();
      return;
    }
    this.close();

    const el = h('div', { class: 'menu glass glass--menu', role: 'menu', 'aria-label': label, tabindex: '-1' });
    const buttons = [];

    for (const item of items) {
      if (!item) continue;
      if (item.separator) {
        el.append(h('div', { class: 'menu__separator', role: 'separator' }));
        continue;
      }
      if (item.header) {
        el.append(h('div', { class: 'menu__header', text: item.header }));
        continue;
      }
      const glyph = item.checked ? 'check' : item.glyph;
      const button = h(
        'button',
        {
          class: `menu__item${item.danger ? ' menu__item--danger' : ''}`,
          type: 'button',
          role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
          'aria-checked': item.checked === undefined ? null : String(Boolean(item.checked)),
          'aria-disabled': item.disabled ? 'true' : null,
          tabindex: '-1',
        },
        glyph ? icon(glyph, item.checked ? 'regular' : (item.weight ?? 'regular')) : h('span'),
        h('span', { class: 'menu__label', text: item.label }),
        item.hint ? h('span', { class: 'menu__hint', text: item.hint }) : null,
      );
      button.addEventListener('click', () => {
        this.close();
        item.onSelect?.();
      });
      button.addEventListener('pointerenter', () => this.#highlight(button));
      el.append(button);
      if (!item.disabled) buttons.push(button);
    }

    this.#layer.append(el);
    this.#position(el, { x, y, anchor, placement });
    anchor?.setAttribute('aria-expanded', 'true');
    anchor?.classList.add('is-open');

    this.#current = { el, anchor, buttons, index: -1, returnFocus: document.activeElement };
    el.focus({ preventScroll: true });
  }

  /** Ferme le menu ouvert (avec une courte animation de sortie). */
  close() {
    const current = this.#current;
    if (!current) return;
    this.#current = null;
    current.anchor?.setAttribute('aria-expanded', 'false');
    current.anchor?.classList.remove('is-open');
    current.el.classList.add('is-closing');
    current.el.addEventListener('animationend', () => current.el.remove(), { once: true });
    setTimeout(() => current.el.remove(), 260); // filet de sécurité
    if (current.returnFocus?.isConnected && current.el.contains(document.activeElement)) {
      current.returnFocus.focus({ preventScroll: true });
    }
  }

  #position(el, { x, y, anchor, placement }) {
    const margin = rem(0.5);
    const gap = rem(0.375);
    const { width, height } = el.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    let left = x;
    let top = y;
    let originX = 'left';
    let originY = 'top';

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const [side, align] = placement.split('-');
      left = align === 'end' ? rect.right - width : rect.left;
      originX = align === 'end' ? 'right' : 'left';
      if (side === 'top') {
        top = rect.top - gap - height;
        originY = 'bottom';
        if (top < margin) {
          top = rect.bottom + gap;
          originY = 'top';
        }
      } else {
        top = rect.bottom + gap;
        if (top + height > viewportH - margin && rect.top - gap - height >= margin) {
          top = rect.top - gap - height;
          originY = 'bottom';
        }
      }
    } else {
      // Menu contextuel : s'ouvre vers la gauche ou vers le haut s'il déborde.
      if (left + width > viewportW - margin) {
        left = x - width;
        originX = 'right';
      }
      if (top + height > viewportH - margin) {
        top = y - height;
        originY = 'bottom';
      }
    }

    left = clamp(left, margin, Math.max(margin, viewportW - width - margin));
    top = clamp(top, margin, Math.max(margin, viewportH - height - margin));
    el.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
    el.style.setProperty('--origin', `${originX} ${originY}`);
  }

  #highlight(button) {
    const current = this.#current;
    if (!current) return;
    for (const other of current.buttons) other.classList.toggle('is-highlighted', other === button);
    current.index = current.buttons.indexOf(button);
  }

  #onKeyDown(event) {
    const current = this.#current;
    if (!current) return;
    const count = current.buttons.length;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    } else if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      this.#highlight(current.buttons[(current.index + 1) % count]);
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      this.#highlight(current.buttons[(current.index - 1 + count) % count]);
    } else if (event.key === 'Home' && count) {
      event.preventDefault();
      this.#highlight(current.buttons[0]);
    } else if (event.key === 'End' && count) {
      event.preventDefault();
      this.#highlight(current.buttons[count - 1]);
    } else if ((event.key === 'Enter' || event.key === ' ') && current.index >= 0) {
      event.preventDefault();
      event.stopPropagation();
      current.buttons[current.index].click();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.close();
    }
  }
}
