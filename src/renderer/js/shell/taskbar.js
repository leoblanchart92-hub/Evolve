/**
 * Evolve — Barre des tâches.
 *
 *  gauche  : bouton Widgets
 *  centre  : bouton Démarrer, barre de recherche, applications
 *  droite  : paramètres rapides (réseau, son, batterie), horloge/date, notifications
 */

import { h, rem } from '../core/dom.js';
import { icon, logo, setIcon } from '../core/icons.js';
import { onTick } from '../core/clock.js';
import { formatLongDate, formatShortDate, formatTime } from '../core/format.js';
import { TASKBAR_PINNED, appLabel, getApp } from '../data/apps.js';
import { networkGlyph, ui, volumeGlyph } from './ui-state.js';

export class Taskbar {
  #shell;
  #apps;
  /** @type {Map<string, HTMLButtonElement>} */
  #appButtons = new Map();
  #flyoutButtons = [];

  /**
   * @param {HTMLElement} el
   * @param {import('./shell.js').Shell} shell
   */
  constructor(el, shell) {
    this.el = el;
    this.#shell = shell;

    this.#apps = h('div', { class: 'tb-apps', role: 'group', 'aria-label': 'Applications' });

    el.append(
      h('div', { class: 'taskbar__left' }, this.#buildWidgetsButton()),
      h('div', { class: 'taskbar__center' }, this.#buildStartButton(), this.#buildSearchButton(), this.#apps),
      h('div', { class: 'taskbar__right' }, this.#buildTrayButton(), this.#buildClockButton()),
    );

    for (const appId of TASKBAR_PINNED) this.#addApp(appId, { animate: false });

    shell.wm.on('change', (state) => this.#syncApps(state));
    shell.flyouts.on('change', (current) => this.#syncFlyouts(current));

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const button = event.target.closest('.tb-app');
      if (button) this.#showAppMenu(button);
    });
  }

  /** Rectangle de l'icône d'une application (cible des animations de fenêtre). */
  anchorRect(appId) {
    const button = this.#appButtons.get(appId);
    const target = button?.querySelector('.app-icon') ?? this.#apps;
    return target.getBoundingClientRect();
  }

  /** Fait rebondir l'icône d'une application (lancement). */
  bounce(appId) {
    const button = this.#appButtons.get(appId);
    if (!button) return;
    button.classList.remove('is-launching');
    void button.offsetWidth; // relance l'animation
    button.classList.add('is-launching');
    button.addEventListener('animationend', () => button.classList.remove('is-launching'), { once: true });
  }

  // --- Construction ----------------------------------------------------------

  #flyoutButton(name, props, ...children) {
    const button = h(
      'button',
      { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', ...props, dataset: { flyout: name } },
      ...children,
    );
    this.#flyoutButtons.push(button);
    return button;
  }

  #buildWidgetsButton() {
    const button = h(
      'button',
      { class: 'tb-btn tb-widgets', type: 'button', 'aria-pressed': 'true' },
      icon('squares-four', 'fill'),
      h('span', { class: 'tb-widgets__label', text: 'Widgets' }),
    );
    button.addEventListener('click', () => ui.toggle('widgetsVisible'));
    ui.subscribe('widgetsVisible', (visible) => {
      button.setAttribute('aria-pressed', String(visible));
      button.dataset.tip = visible ? 'Masquer les widgets' : 'Afficher les widgets';
    });
    return button;
  }

  #buildStartButton() {
    const button = this.#flyoutButton(
      'start',
      { class: 'tb-btn tb-start', 'aria-label': 'Démarrer', 'data-tip': 'Démarrer' },
      logo(),
    );
    button.addEventListener('click', () => this.#shell.flyouts.toggle('start'));
    return button;
  }

  #buildSearchButton() {
    const button = this.#flyoutButton(
      'start',
      { class: 'tb-btn tb-search', 'aria-label': 'Rechercher', 'data-search': '' },
      icon('magnifying-glass'),
      h('span', { class: 'tb-search__text', text: 'Rechercher' }),
    );
    // Ouvre le menu Démarrer avec le champ de recherche actif.
    button.addEventListener('click', () => this.#shell.flyouts.open('start', { focusSearch: true }));
    return button;
  }

  #buildTrayButton() {
    const network = icon('wifi-high', 'fill');
    const volume = icon('speaker-high', 'fill');
    const battery = icon('battery-high', 'fill');
    const button = this.#flyoutButton(
      'quick-settings',
      { class: 'tb-btn tb-tray', 'aria-label': 'Paramètres rapides', 'data-tip': 'Paramètres rapides' },
      network,
      volume,
      battery,
    );
    button.addEventListener('click', () => this.#shell.flyouts.toggle('quick-settings'));

    const syncNetwork = () => setIcon(network, networkGlyph({ wifi: ui.get('wifi'), airplane: ui.get('airplane') }), 'fill');
    ui.subscribe('wifi', syncNetwork);
    ui.subscribe('airplane', syncNetwork, { immediate: false });
    const syncVolume = () => setIcon(volume, volumeGlyph(ui.get('volume'), ui.get('muted')), 'fill');
    ui.subscribe('volume', syncVolume);
    ui.subscribe('muted', syncVolume, { immediate: false });
    return button;
  }

  #buildClockButton() {
    const time = h('span', { class: 'tb-clock__time tabular' });
    const date = h('span', { class: 'tb-clock__date tabular' });
    const bell = icon('bell', 'fill');
    const badge = h('span', { class: 'tb-badge', hidden: true });
    const button = this.#flyoutButton(
      'notifications',
      { class: 'tb-btn tb-clock', 'aria-label': 'Notifications et calendrier' },
      h('span', { class: 'tb-clock__text' }, time, date),
      h('span', { class: 'tb-bell' }, bell, badge),
    );
    button.addEventListener('click', () => this.#shell.flyouts.toggle('notifications'));

    onTick((now) => {
      time.textContent = formatTime(now);
      date.textContent = formatShortDate(now);
      button.dataset.tip = formatLongDate(now);
    });
    ui.subscribe('notificationCount', (count) => {
      badge.hidden = count <= 0;
      if (count > 0) badge.textContent = count > 9 ? '9+' : String(count);
    });
    ui.subscribe('doNotDisturb', (enabled) => setIcon(bell, enabled ? 'bell-slash' : 'bell', 'fill'));
    return button;
  }

  // --- Applications ----------------------------------------------------------

  #addApp(appId, { animate = true } = {}) {
    const app = getApp(appId);
    if (!app || this.#appButtons.has(appId)) return;
    const button = h(
      'button',
      {
        class: `tb-app${animate ? ' is-entering' : ''}`,
        type: 'button',
        'aria-label': app.name,
        'data-tip': app.name,
        dataset: { app: appId },
      },
      h('span', { class: 'app-icon', style: { '--g1': app.colors[0], '--g2': app.colors[1] } }, icon(app.glyph, 'fill')),
    );
    button.addEventListener('click', () => this.#activate(appId));
    if (animate) button.addEventListener('animationend', () => button.classList.remove('is-entering'), { once: true });
    this.#appButtons.set(appId, button);
    this.#apps.append(button);
  }

  #removeApp(appId) {
    const button = this.#appButtons.get(appId);
    if (!button) return;
    this.#appButtons.delete(appId);
    button.classList.add('is-leaving');
    button.addEventListener('animationend', () => button.remove(), { once: true });
    setTimeout(() => button.remove(), 400); // filet de sécurité
  }

  /** Clic sur une icône : lance l'application, ou réduit / restaure sa fenêtre. */
  #activate(appId) {
    const shell = this.#shell;
    shell.flyouts.close();
    if (shell.wm.toggle(appId)) return;
    shell.launch(appId, { origin: this.anchorRect(appId) });
  }

  #syncApps({ windows, active }) {
    const running = new Set(windows.map((win) => win.app.id));

    // Les applications ouvertes non épinglées rejoignent la barre…
    for (const appId of running) this.#addApp(appId);
    // … et la quittent à leur fermeture.
    for (const appId of [...this.#appButtons.keys()]) {
      if (!running.has(appId) && !TASKBAR_PINNED.includes(appId)) this.#removeApp(appId);
    }

    for (const [appId, button] of this.#appButtons) {
      const isRunning = running.has(appId);
      const isActive = active?.app.id === appId;
      button.classList.toggle('is-running', isRunning);
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  }

  #syncFlyouts(current) {
    for (const button of this.#flyoutButtons) {
      const active = button.dataset.flyout === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-expanded', String(active));
    }
  }

  #showAppMenu(button) {
    const shell = this.#shell;
    const appId = button.dataset.app;
    const app = getApp(appId);
    const win = shell.wm.find(appId);
    const items = [{ header: appLabel(app) }];

    if (!win) {
      items.push({ label: 'Ouvrir', glyph: 'arrow-square-out', onSelect: () => this.#activate(appId) });
    } else {
      const isActive = shell.wm.active === win;
      items.push(
        {
          label: isActive ? 'Réduire' : 'Afficher',
          glyph: isActive ? 'minus' : 'app-window',
          onSelect: () => shell.wm.toggle(appId),
        },
        { separator: true },
        { label: 'Fermer la fenêtre', glyph: 'x', danger: true, onSelect: () => win.close() },
      );
    }

    // Menu contextuel placé juste au-dessus de l'icône.
    const rect = button.getBoundingClientRect();
    shell.menus.show({ x: rect.left, y: rect.top - rem(0.5), label: app.name, items });
  }
}
