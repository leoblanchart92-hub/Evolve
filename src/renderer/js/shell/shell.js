/**
 * Evolve — L'environnement de bureau : assemble tous les composants de
 * l'interface (bureau, widgets, fenêtres, barre des tâches, panneaux, menus)
 * et tient ce qui les relie : le lancement des applications, les raccourcis
 * clavier du bureau et le passage du clavier d'une zone de l'écran à l'autre.
 */

import { getApp, isAvailable } from '../data/apps.js';
import { mounterFor } from '../apps/index.js';
import { WindowSwitcher } from '../wm/switcher.js';
import { MAX_WINDOWS, WindowManager } from '../wm/window-manager.js';
import { MenuLayer } from './context-menu.js';
import { Desktop } from './desktop.js';
import { Dialogs } from './dialogs.js';
import { FlyoutController } from './flyouts.js';
import { NotificationCenter } from './notification-center.js';
import { QuickSettings } from './quick-settings.js';
import { commandFor, shortcutLabel } from './shortcuts.js';
import { StartMenu } from './start-menu.js';
import { Taskbar } from './taskbar.js';
import { Toasts } from './toasts.js';
import { installTooltips } from './tooltip.js';
import { Widgets } from './widgets.js';
import { createWindowPlacement } from './window-placement.js';

/** Commandes qui portent sur la fenêtre active : sans effet tant qu'un panneau (menu Démarrer…) est ouvert. */
const WINDOW_COMMANDS = new Set(['close-window', 'new-window', 'window-maximize', 'window-restore', 'window-snap-left', 'window-snap-right']);

/** Vrai si l'élément peut recevoir le clavier : visible, actif, et relié à la page. */
function canFocus(node) {
  return node instanceof HTMLElement && node.isConnected && !node.disabled && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0;
}

export class Shell {
  #windowsLayer;

  /** @param {Document} [doc] */
  constructor(doc = document) {
    const $ = (id) => {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`Élément #${id} introuvable dans index.html`);
      return el;
    };

    this.menus = new MenuLayer($('menus'));
    // Une fenêtre de dialogue qui s'ouvre referme le menu d'où elle vient.
    this.dialogs = new Dialogs($('dialogs'), { onOpen: () => this.menus.close() });
    this.toasts = new Toasts($('toasts'));
    this.tooltips = installTooltips($('tooltip'));
    this.flyouts = new FlyoutController($('flyouts'), {
      isMenuTarget: (node) => this.menus.contains(node),
      // Panneau refermé : le clavier retourne où il était, sinon à la fenêtre active.
      restoreFocus: (previous) => {
        if (canFocus(previous)) previous.focus({ preventScroll: true });
        else this.wm.active?.focusContent();
      },
    });
    this.#windowsLayer = $('windows');
    this.wm = new WindowManager(this.#windowsLayer, {
      getAnchorRect: (appId) => this.taskbar.anchorRect(appId),
      menus: this.menus,
      placement: createWindowPlacement(),
      hint: shortcutLabel,
      onLimit: () =>
        this.toasts.show({
          key: 'too-many-windows',
          title: 'Trop de fenêtres ouvertes',
          message: `Evolve garde au plus ${MAX_WINDOWS} fenêtres ouvertes à la fois. Fermez-en une pour en ouvrir une autre.`,
          glyph: 'warning-circle',
        }),
    });
    this.switcher = new WindowSwitcher($('dialogs'), this.wm);

    this.taskbar = new Taskbar($('taskbar'), this);
    this.desktop = new Desktop($('desktop'), this);
    this.widgets = new Widgets($('widgets'));

    this.flyouts.register(new StartMenu(this));
    this.flyouts.register(new QuickSettings($('screen-fx')));
    this.flyouts.register(new NotificationCenter());

    // L'interface gère ses propres menus : pas de menu ni de glisser-déposer natifs.
    doc.addEventListener('contextmenu', (event) => event.preventDefault());
    doc.addEventListener('dragstart', (event) => event.preventDefault());

    // Raccourcis du bureau : reconnus avant que la fenêtre active ne reçoive la touche.
    doc.addEventListener('keydown', (event) => this.#onKeyDown(event), true);
    // Ctrl relâché : la fenêtre désignée par la bascule est activée.
    doc.addEventListener('keyup', (event) => {
      if (event.key === 'Control') this.switcher.commit();
    }, true);
    // Une fenêtre de Windows passe devant Evolve : la bascule en cours est abandonnée.
    window.addEventListener('blur', () => this.switcher.cancel());
  }

  /**
   * Ouvre une application dans une fenêtre, ou réactive l'une de ses fenêtres.
   *
   * Une application qui admet plusieurs fenêtres (l'explorateur) reçoit, pour
   * un emplacement demandé, la fenêtre qui l'affiche déjà — sinon une nouvelle
   * fenêtre. Sans emplacement, sa fenêtre la plus récente est réactivée.
   *
   * @param {string} appId
   * @param {object} [options]
   * @param {any} [options.params]  paramètres transmis à l'application (emplacement à afficher…)
   * @param {DOMRect|null} [options.origin]  rectangle de l'icône cliquée, d'où la fenêtre « sort »
   * @param {'auto'|'new'|'reuse'} [options.target]  « new » : toujours une nouvelle fenêtre ;
   *        « reuse » : toujours la fenêtre la plus récente, qui affiche alors l'emplacement demandé
   * @returns {object|null} la fenêtre, ou `null` si rien n'a été ouvert
   */
  launch(appId, { params, origin = null, target = 'auto' } = {}) {
    const app = getApp(appId);
    if (!app) return null;
    // Une application seulement annoncée n'ouvre rien : aucune fenêtre factice ne simule ce qui n'existe pas.
    const mount = isAvailable(app) ? mounterFor(app.kind) : null;
    if (!mount) {
      this.announceUpcoming(app);
      return null;
    }

    const { wm } = this;
    let newWindow = false;
    if (app.multiWindow && target === 'new') {
      newWindow = true;
    } else if (app.multiWindow && target === 'auto' && params !== undefined) {
      const shown = wm.recent.find((win) => win.app.id === app.id && win.controller?.shows?.(params) === true);
      if (shown) {
        wm.activate(shown);
        return shown;
      }
      newWindow = true;
    }

    const count = wm.windows.length;
    const win = wm.open(app, { mount: (frame, options) => mount(frame, options, this), params, origin, newWindow });
    if (win && wm.windows.length > count) this.taskbar.bounce(appId);
    return win;
  }

  /** Signale qu'une application est annoncée, mais pas encore disponible. */
  announceUpcoming(app) {
    this.toasts.show({
      key: 'app-upcoming',
      title: `${app.name} : bientôt disponible`,
      message: "Cette application n'existe pas encore dans cette version d'Evolve : rien n'a été ouvert.",
      glyph: app.glyph,
      colors: app.colors,
    });
  }

  /**
   * Exécute une commande du bureau (voir shortcuts.js).
   * @param {string} command
   */
  run(command) {
    const { wm } = this;
    const active = wm.active;
    if (this.flyouts.current && WINDOW_COMMANDS.has(command)) return;

    if (command === 'switch-next' || command === 'switch-previous') {
      this.menus.close();
      this.flyouts.close();
      this.switcher.step(command === 'switch-next' ? 1 : -1);
    } else if (command === 'close-window') {
      active?.close();
    } else if (command === 'new-window') {
      // Une fenêtre de plus pour l'application active, sur l'emplacement qu'elle affiche.
      if (active?.app.multiWindow) this.launch(active.app.id, { target: 'new', params: active.controller?.newWindowParams?.() });
    } else if (command === 'start-menu') {
      this.menus.close();
      this.flyouts.toggle('start');
    } else if (command === 'show-desktop') {
      this.menus.close();
      this.flyouts.close();
      wm.toggleDesktop();
    } else if (command === 'open-explorer') {
      this.menus.close();
      this.flyouts.close();
      this.launch('explorer', { target: 'new' });
    } else if (command === 'window-maximize') {
      if (active && !active.maximized) active.maximize();
    } else if (command === 'window-restore') {
      // Comme sous Windows : une fenêtre agrandie ou ancrée est restaurée ; une fenêtre libre est réduite.
      if (active && (active.maximized || active.snap)) active.restoreLayout();
      else active?.minimize();
    } else if (command === 'window-snap-left' || command === 'window-snap-right') {
      const side = command === 'window-snap-left' ? 'left' : 'right';
      if (active?.snap === side) active.restoreLayout();
      else active?.snapTo(side);
    } else if (command === 'next-region') {
      this.focusRegion(1);
    } else if (command === 'previous-region') {
      this.focusRegion(-1);
    }
  }

  /**
   * Passe le clavier à la zone suivante de l'écran (ou précédente, avec -1) :
   * la fenêtre active, la barre des tâches, les icônes du bureau.
   */
  focusRegion(direction = 1) {
    this.menus.close();
    this.flyouts.close();
    const { wm } = this;
    const topWindow = () => wm.active ?? wm.recent.find((win) => !win.minimized) ?? null;
    const regions = [
      { contains: (node) => this.#windowsLayer.contains(node), usable: () => topWindow() !== null, focus: () => wm.activate(topWindow()) },
      { contains: (node) => this.taskbar.el.contains(node), usable: () => true, focus: () => this.taskbar.focus() },
      { contains: (node) => this.desktop.el.contains(node), usable: () => true, focus: () => this.desktop.focus() },
    ];
    const current = regions.findIndex((region) => region.contains(document.activeElement));
    // Depuis nulle part : la première zone ; sinon la suivante qui accepte le clavier.
    for (let step = 1; step <= regions.length; step += 1) {
      const start = current < 0 ? (direction > 0 ? -1 : 0) : current;
      const index = (((start + direction * step) % regions.length) + regions.length) % regions.length;
      const region = regions[index];
      if (!region.usable()) continue;
      if (region.focus() !== false) return;
    }
  }

  #onKeyDown(event) {
    // Une fenêtre de dialogue est modale : aucun raccourci du bureau ne s'applique sous elle.
    if (this.dialogs.isOpen) return;
    const command = commandFor(event);
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (this.switcher.isOpen) {
      if (command === 'switch-next' || command === 'switch-previous') {
        consume();
        this.switcher.step(command === 'switch-next' ? 1 : -1);
        return;
      }
      if (this.switcher.handleKey(event)) {
        consume();
        return;
      }
      // Ctrl toujours enfoncé : les autres touches attendent la fin de la bascule.
      if (event.ctrlKey || event.key === 'Shift') {
        if (event.key !== 'Control' && event.key !== 'Shift') consume();
        return;
      }
      // Ctrl relâché sans que la page l'ait su : la bascule est abandonnée, la touche suit son cours.
      this.switcher.cancel();
    }

    if (!command) return;
    consume();
    this.run(command);
  }
}
