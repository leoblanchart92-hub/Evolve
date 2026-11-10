/**
 * Evolve — Infobulles.
 * Tout élément portant l'attribut `data-tip="Texte"` affiche une infobulle de
 * verre après un court survol.
 */

import { clamp, rem } from '../core/dom.js';
import { TIMING } from '../config.js';

export function installTooltips(el) {
  let target = null;
  let timer = 0;

  const hide = () => {
    clearTimeout(timer);
    target = null;
    el.classList.remove('is-visible');
  };

  const show = () => {
    if (!target?.isConnected) return hide();
    const text = target.dataset.tip;
    if (!text) return hide();

    el.textContent = text;
    el.hidden = false;

    const margin = rem(0.5);
    const gap = rem(0.5);
    const anchor = target.getBoundingClientRect();
    const size = el.getBoundingClientRect();
    let top = anchor.top - gap - size.height;
    if (top < margin) top = anchor.bottom + gap; // pas de place au-dessus : en dessous
    const left = clamp(
      anchor.left + anchor.width / 2 - size.width / 2,
      margin,
      Math.max(margin, window.innerWidth - size.width - margin),
    );
    el.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
    el.classList.add('is-visible');
  };

  document.addEventListener('mouseover', (event) => {
    const candidate = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
    if (candidate === target) return;
    hide();
    if (!candidate) return;
    target = candidate;
    timer = setTimeout(show, TIMING.tooltipDelay);
  });

  document.addEventListener('mouseout', (event) => {
    if (!target) return;
    const next = event.relatedTarget;
    if (next instanceof Node && target.contains(next)) return;
    hide();
  });

  // Toute interaction masque l'infobulle.
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    document.addEventListener(type, hide, { capture: true, passive: true });
  }
  window.addEventListener('blur', hide);

  return { hide };
}
