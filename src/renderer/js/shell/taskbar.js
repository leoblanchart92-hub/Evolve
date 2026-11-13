/**
 * Evolve — Barre des tâches.
 *
 *  gauche  : bouton Widgets
 *  centre  : bouton Démarrer, barre de recherche, applications
 *  droite  : paramètres rapides (réseau, son, batterie), horloge/date,
 *            notifications, bouton « Afficher le bureau »
 *
 * Les boutons d'application reflètent les fenêtres ouvertes (taskbar-model.js) :
 * un témoin par application ouverte, mis en évidence si l'une de ses fenêtres
 * est active, doublé si elle en a plusieurs. Un clic lance l'application,
 * active ou réduit sa fenêtre, ou propose la liste de ses fenêtres.
 *
 * Au clavier, les flèches gauche et droite passent d'un bouton à l'autre ;
 * la touche Menu (ou Maj + F10) ouvre le menu d'une application.
 */

import { h, rem } from '../core/dom.js';
import { icon, logo, setIcon } from '../core/icons.js';
import { onTick } from '../core/clock.js';
import { formatLongDate, formatShortDate, formatTime } from '../core/format.js';
import { targetIndex } from '../core/spatial.js';
import { TASKBAR_PINNED, appLabel, getApp } from '../data/apps.js';
import { shortcutLabel } from './shortcuts.js';
import { buttonTip, clickAction, taskbarButtons } from './taskbar-model.js';
import { networkGlyph, ui, volumeGlyph } from './ui-state.js';

/** Nombre de fenêtres au-delà duquel le témoin d'une application ne change plus. */
const MAX_PIPS = 3;

export class Taskbar {
  #shell;
  #apps;
  /** @type {Map<string, HTMLButtonElement>} */
  #appButtons = new Map();
  /** @type {Map<string, import('./taskbar-model.js').TaskbarButton>} état de chaque bouton d'application */
  #models = new Map();
  #flyoutButtons = [];
  #desktopButton;
  /** Dernier bouton de la barre à avoir eu le clavier : F6 y revient. */
  #lastFocused = null;

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
      h('div', { class: 'taskbar__right' }, this.#buildTrayButton(), this.#buildClockButton(), this.#buildDesktopButton()),
    );

    for (const appId of TASKBAR_PINNED) this.#addApp(appId, { animate: false });
    this.#syncApps();

    shell.wm.on('change', () => this.#syncApps());
    shell.flyouts.on('change', (current) => this.#syncFlyouts(current));

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const button = event.target.closest('.tb-app');
      if (button) this.#showAppMenu(button);
    });
    el.addEventListener('keydown', (event) => this.#onKeyDown(event));
    el.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLButtonElement) this.#lastFocused = event.target;
    });
  }

  /** Rectangle de l'icône d'une application (cible des animations de fenêtre). */
  anchorRect(appId) {
    const button = this.#appButtons.get(appId);
    const target = button?.querySelector('.app-icon') ?? this.#apps;
    return target.getBoundingClientRect();
  }

  /** Donne le clavier à la barre des tâches : au bouton qui l'avait en dernier, sinon au bouton Démarrer. */
  focus() {
    const target = this.#lastFocused?.isConnected ? this.#lastFocused : this.el.querySelector('.tb-start');
    target?.focus({ preventScroll: true });
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
      { class: 'tb-btn tb-start', 'aria-label': 'Démarrer', 'data-tip': `Démarrer (${shortcutLabel('start-menu')})` },
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

  /**
   * « Afficher le bureau » : réduit toutes les fenêtres d'un geste, puis les
   * rétablit — comme la fine bande à l'extrémité de la barre des tâches de Windows.
   */
  #buildDesktopButton() {
    const label = 'Afficher le bureau';
    const button = h('button', { class: 'tb-btn tb-desktop', type: 'button', 'aria-label': label, 'aria-pressed': 'false', 'data-tip': `${label} (${shortcutLabel('show-desktop')})` }, h('span', { class: 'tb-desktop__mark' }));
    button.addEventListener('click', () => {
      this.#shell.flyouts.close();
      this.#shell.wm.toggleDesktop();
    });
    this.#desktopButton = button;
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
        dataset: { app: appId, windows: '0' },
      },
      h('span', { class: 'app-icon', style: { '--g1': app.colors[0], '--g2': app.colors[1] } }, icon(app.glyph, 'fill')),
    );
    // Clic : lancer, activer, réduire ou choisir. Avec Maj, ou du bouton du milieu : une fenêtre de plus.
    button.addEventListener('click', (event) => this.#activate(appId, { newWindow: event.shiftKey }));
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) this.#activate(appId, { newWindow: true });
    });
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

  /**
   * Clic sur le bouton d'une application : la lancer ; activer sa fenêtre, ou
   * la réduire si elle était active ; proposer la liste de ses fenêtres si
   * elle en a plusieurs.
   */
  #activate(appId, { newWindow = false } = {}) {
    const shell = this.#shell;
    const app = getApp(appId);
    const model = this.#models.get(appId) ?? { appId, windows: [] };
    const action = clickAction(model, { newWindow: newWindow && Boolean(app?.multiWindow) });
    if (action.type !== 'pick') shell.menus.close();
    shell.flyouts.close();
    if (action.type === 'launch') shell.launch(appId, { origin: this.anchorRect(appId) });
    else if (action.type === 'new-window') shell.launch(appId, { origin: this.anchorRect(appId), target: 'new' });
    else if (action.type === 'minimize') shell.wm.minimize(shell.wm.get(action.id));
    else if (action.type === 'activate') shell.wm.activate(shell.wm.get(action.id));
    else this.#showWindowList(this.#appButtons.get(appId));
  }

  #syncApps() {
    const { wm } = this.#shell;
    const buttons = taskbarButtons({
      pinned: [...TASKBAR_PINNED],
      windows: wm.windows.map((win) => ({ id: win.id, appId: win.app.id, title: win.title, minimized: win.minimized })),
      activeId: wm.active?.id ?? null,
    });
    this.#models = new Map(buttons.map((model) => [model.appId, model]));

    // Les applications ouvertes non épinglées rejoignent la barre…
    for (const { appId } of buttons) this.#addApp(appId);
    // … et la quittent à leur fermeture.
    for (const appId of [...this.#appButtons.keys()]) {
      if (!this.#models.has(appId)) this.#removeApp(appId);
    }

    for (const [appId, button] of this.#appButtons) {
      const model = this.#models.get(appId);
      const app = getApp(appId);
      const count = model.windows.length;
      button.classList.toggle('is-running', model.running);
      button.classList.toggle('is-active', model.active);
      button.classList.toggle('is-multiple', count > 1);
      button.dataset.windows = String(Math.min(count, MAX_PIPS));
      button.setAttribute('aria-pressed', String(model.active));
      button.setAttribute('aria-label', count > 1 ? `${app.name}, ${count} fenêtres` : count === 1 ? `${app.name}, 1 fenêtre` : app.name);
      button.dataset.tip = buttonTip(model, app.name);
      if (count > 1) button.setAttribute('aria-haspopup', 'menu');
      else button.removeAttribute('aria-haspopup');
    }

    const peeking = wm.desktopShown;
    this.#desktopButton.classList.toggle('is-active', peeking);
    this.#desktopButton.setAttribute('aria-pressed', String(peeking));
    const label = peeking ? 'Rétablir les fenêtres' : 'Afficher le bureau';
    this.#desktopButton.setAttribute('aria-label', label);
    this.#desktopButton.dataset.tip = `${label} (${shortcutLabel('show-desktop')})`;
  }

  #syncFlyouts(current) {
    for (const button of this.#flyoutButtons) {
      const active = button.dataset.flyout === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-expanded', String(active));
    }
  }

  /** Éléments de menu qui désignent chacune des fenêtres d'une application. */
  #windowItems(appId) {
    const { wm } = this.#shell;
    return wm.windowsOf(appId).map((win) => ({
      label: win.title,
      glyph: win.minimized ? 'minus' : 'app-window',
      hint: win.minimized ? 'Réduite' : '',
      checked: wm.active === win ? true : undefined,
      onSelect: () => wm.activate(win),
    }));
  }

  /** Liste des fenêtres d'une application qui en a plusieurs (clic sur son bouton). */
  #showWindowList(button) {
    const shell = this.#shell;
    const appId = button.dataset.app;
    const app = getApp(appId);
    shell.menus.show({
      anchor: button,
      placement: 'top-start',
      label: `Fenêtres de ${app.name}`,
      items: [{ header: `${appLabel(app)} — ${shell.wm.windowsOf(appId).length} fenêtres` }, ...this.#windowItems(appId)],
    });
  }

  /** Menu d'une application (clic droit, touche Menu) : ses fenêtres, une nouvelle fenêtre, réduire, fermer. */
  #showAppMenu(button) {
    const shell = this.#shell;
    const { wm } = shell;
    const appId = button.dataset.app;
    const app = getApp(appId);
    const windows = wm.windowsOf(appId);
    const items = [{ header: appLabel(app) }];
    const open = (target) => shell.launch(appId, { origin: this.anchorRect(appId), target });

    if (windows.length === 0) {
      items.push({ label: 'Ouvrir', glyph: 'arrow-square-out', onSelect: () => open('auto') });
    } else {
      if (windows.length > 1) items.push(...this.#windowItems(appId), { separator: true });
      if (app.multiWindow) items.push({ label: 'Nouvelle fenêtre', glyph: 'plus', hint: shortcutLabel('new-window'), onSelect: () => open('new') });
      if (windows.length === 1) {
        const [win] = windows;
        const isActive = wm.active === win;
        items.push({
          label: isActive ? 'Réduire' : 'Afficher',
          glyph: isActive ? 'minus' : 'app-window',
          onSelect: () => (isActive ? wm.minimize(win) : wm.activate(win)),
        });
      } else {
        items.push({ label: 'Réduire toutes les fenêtres', glyph: 'minus', disabled: windows.every((win) => win.minimized), onSelect: () => windows.forEach((win) => wm.minimize(win)) });
      }
      items.push(
        { separator: true },
        {
          label: windows.length > 1 ? 'Fermer toutes les fenêtres' : 'Fermer la fenêtre',
          glyph: 'x',
          danger: true,
          onSelect: () => windows.forEach((win) => wm.close(win)),
        },
      );
    }

    // Menu contextuel placé juste au-dessus de l'icône.
    const rect = button.getBoundingClientRect();
    shell.menus.show({ x: rect.left, y: rect.top - rem(0.5), label: app.name, items });
  }

  // --- Clavier ---------------------------------------------------------------------

  #onKeyDown(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const current = event.target instanceof HTMLButtonElement ? event.target : null;
    if (!current) return;

    // Touche Menu, ou Maj + F10 : menu de l'application.
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && current.classList.contains('tb-app')) {
      event.preventDefault();
      this.#showAppMenu(current);
      return;
    }
    if (event.shiftKey) return;
    // Flèches gauche et droite, Début, Fin : d'un bouton à l'autre.
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...this.el.querySelectorAll('button')].filter((button) => !button.classList.contains('is-leaving'));
    const index = targetIndex(event.key, buttons.indexOf(current), buttons.map((button) => button.getBoundingClientRect()));
    if (index < 0) return;
    event.preventDefault();
    buttons[index].focus({ preventScroll: true });
  }
}
