/**
 * Evolve — Panneau des paramètres rapides.
 *
 * RÉGLAGES VISUELS UNIQUEMENT : ces commandes changent l'apparence de
 * l'interface (icônes, luminosité simulée, teinte nocturne). Elles ne lisent
 * ni ne modifient aucun paramètre de Windows.
 */

import { h } from '../core/dom.js';
import { icon, setIcon } from '../core/icons.js';
import { Flyout } from './flyouts.js';
import { ui, volumeGlyph } from './ui-state.js';

const TILES = [
  { id: 'wifi', label: 'Wi-Fi', on: 'wifi-high', off: 'wifi-slash' },
  { id: 'bluetooth', label: 'Bluetooth', on: 'bluetooth', off: 'bluetooth-slash' },
  { id: 'airplane', label: 'Mode avion', on: 'airplane-tilt', off: 'airplane-tilt' },
  { id: 'energySaver', label: "Économie d'énergie", on: 'leaf', off: 'leaf' },
  { id: 'nightLight', label: 'Éclairage nocturne', on: 'moon', off: 'moon' },
  { id: 'doNotDisturb', label: 'Ne pas déranger', on: 'bell-slash', off: 'bell' },
];

/** Luminosité minimale du curseur : l'écran ne devient jamais illisible. */
const BRIGHTNESS_MIN = 20;

export class QuickSettings extends Flyout {
  /** États du Wi-Fi et du Bluetooth mémorisés avant le mode avion. */
  #beforeAirplane = null;

  /** @param {HTMLElement} screenFx  calque des effets d'écran */
  constructor(screenFx) {
    const el = h('section', {
      class: 'side-flyout qs glass glass--neon',
      role: 'dialog',
      'aria-label': 'Paramètres rapides',
      tabindex: '-1',
    });
    super('quick-settings', el);

    el.append(
      h('div', { class: 'qs__tiles', role: 'group', 'aria-label': 'Réglages' }, TILES.map((tile, index) => this.#buildTile(tile, index))),
      h(
        'div',
        { class: 'qs__sliders' },
        this.#buildSlider({
          id: 'brightness',
          label: 'Luminosité',
          min: BRIGHTNESS_MIN,
          glyph: () => (ui.get('brightness') < 55 ? 'sun-dim' : 'sun'),
        }),
        this.#buildSlider({
          id: 'volume',
          label: 'Volume',
          min: 0,
          glyph: () => volumeGlyph(ui.get('volume'), ui.get('muted')),
          onIconClick: () => ui.toggle('muted'),
          iconLabel: 'Activer ou couper le son',
        }),
      ),
      h(
        'footer',
        { class: 'qs__footer' },
        h(
          'div',
          { class: 'qs__battery' },
          icon('battery-high', 'fill'),
          h('span', { class: 'tabular', text: 'Batterie 82 %' }),
          h('span', { class: 'chip chip--demo', text: 'Démo', 'data-tip': 'Valeur fictive : la batterie réelle n’est pas lue' }),
        ),
        h(
          'p',
          { class: 'qs__note' },
          icon('info', 'fill'),
          h('span', { text: 'Réglages visuels uniquement — aucun paramètre Windows n’est modifié.' }),
        ),
      ),
    );

    this.#bindEffects(screenFx);
  }

  onOpen({ highlight } = {}) {
    this.el.focus({ preventScroll: true });
    this.#spotlight(highlight);
  }

  onReopen({ highlight } = {}) {
    this.#spotlight(highlight);
  }

  onClose() {
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
  }

  // --- Construction ----------------------------------------------------------

  #buildTile({ id, label, on, off }, index) {
    const glyph = icon(on, 'fill');
    const state = h('span', { class: 'qs-tile__state' });
    const button = h(
      'button',
      { class: 'qs-tile', type: 'button', 'aria-pressed': 'false', dataset: { setting: id }, style: { '--i': String(index) } },
      glyph,
      h('span', { class: 'qs-tile__label' }, h('span', { class: 'qs-tile__name', text: label }), state),
    );
    button.addEventListener('click', () => this.#toggle(id));

    const sync = () => {
      const enabled = Boolean(ui.get(id));
      const blocked = ui.get('airplane') && (id === 'wifi' || id === 'bluetooth');
      button.setAttribute('aria-pressed', String(enabled));
      button.setAttribute('aria-disabled', String(blocked));
      setIcon(glyph, enabled ? on : off, enabled ? 'fill' : 'regular');
      state.textContent = blocked ? 'Mode avion' : enabled ? 'Activé' : 'Désactivé';
    };
    ui.subscribe(id, sync);
    if (id === 'wifi' || id === 'bluetooth') ui.subscribe('airplane', sync, { immediate: false });
    return button;
  }

  #buildSlider({ id, label, min, glyph, onIconClick, iconLabel }) {
    const glyphIcon = icon(glyph(), 'fill');
    const iconHolder = onIconClick
      ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': iconLabel, 'data-tip': iconLabel }, glyphIcon)
      : h('span', { class: 'qs-slider__icon' }, glyphIcon);
    if (onIconClick) iconHolder.addEventListener('click', onIconClick);

    const input = h('input', {
      class: 'slider',
      type: 'range',
      min: String(min),
      max: '100',
      step: '1',
      'aria-label': label,
    });
    const value = h('span', { class: 'qs-slider__value tabular' });

    input.addEventListener('input', () => {
      ui.set(id, Number(input.value));
      // Déplacer le curseur du volume réactive le son.
      if (id === 'volume' && ui.get('muted')) ui.set('muted', false);
    });

    const sync = () => {
      const current = ui.get(id);
      const muted = id === 'volume' && ui.get('muted');
      const shown = muted ? 0 : current;
      if (Number(input.value) !== current) input.value = String(current);
      input.style.setProperty('--pct', `${((shown - min) / (100 - min)) * 100}%`);
      input.setAttribute('aria-valuetext', muted ? 'Son coupé' : `${current} %`);
      value.textContent = muted ? 'Muet' : `${current} %`;
      setIcon(glyphIcon, glyph(), 'fill');
    };
    ui.subscribe(id, sync);
    if (id === 'volume') ui.subscribe('muted', sync, { immediate: false });

    return h('div', { class: 'qs-slider', dataset: { setting: id } }, iconHolder, input, value);
  }

  // --- Comportement ----------------------------------------------------------

  #toggle(id) {
    if (id !== 'airplane') {
      ui.toggle(id);
      return;
    }
    // Le mode avion coupe (visuellement) le Wi-Fi et le Bluetooth, puis les rétablit.
    if (!ui.get('airplane')) {
      this.#beforeAirplane = { wifi: ui.get('wifi'), bluetooth: ui.get('bluetooth') };
      ui.set('airplane', true);
      ui.set('wifi', false);
      ui.set('bluetooth', false);
    } else {
      const previous = this.#beforeAirplane ?? { wifi: true, bluetooth: true };
      this.#beforeAirplane = null;
      ui.set('airplane', false);
      ui.set('wifi', previous.wifi);
      ui.set('bluetooth', previous.bluetooth);
    }
  }

  /** Effets d'écran : simples calques visuels au-dessus de l'interface. */
  #bindEffects(screenFx) {
    const dim = h('div', { class: 'screen-fx__dim' });
    const night = h('div', { class: 'screen-fx__night' });
    screenFx.append(dim, night);

    ui.subscribe('brightness', (brightness) => {
      dim.style.opacity = String(((100 - brightness) / (100 - BRIGHTNESS_MIN)) * 0.55);
    });
    ui.subscribe('nightLight', (enabled) => night.classList.toggle('is-on', enabled));
  }

  /** Met brièvement en évidence un réglage (ouverture depuis la recherche). */
  #spotlight(id) {
    if (!id) return;
    const target = this.el.querySelector(`[data-setting="${id}"]`);
    if (!target) return;
    target.classList.remove('is-spotlit');
    void target.offsetWidth; // relance l'animation
    target.classList.add('is-spotlit');
    target.addEventListener('animationend', () => target.classList.remove('is-spotlit'), { once: true });
  }
}
