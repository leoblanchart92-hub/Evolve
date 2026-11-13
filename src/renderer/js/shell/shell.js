/**
 * Evolve — L'environnement de bureau : assemble tous les composants de
 * l'interface (bureau, widgets, fenêtres, barre des tâches, panneaux, menus).
 */

import { getApp } from '../data/apps.js';
import { createDemoFileSystem } from '../data/demo-files.js';
import { mounterFor } from '../apps/index.js';
import { WindowManager } from '../wm/window-manager.js';
import { MenuLayer } from './context-menu.js';
import { Desktop } from './desktop.js';
import { Dialogs } from './dialogs.js';
import { FlyoutController } from './flyouts.js';
import { NotificationCenter } from './notification-center.js';
import { QuickSettings } from './quick-settings.js';
import { StartMenu } from './start-menu.js';
import { Taskbar } from './taskbar.js';
import { Toasts } from './toasts.js';
import { installTooltips } from './tooltip.js';
import { Widgets } from './widgets.js';

export class Shell {
  /** @param {Document} [doc] */
  constructor(doc = document) {
    const $ = (id) => {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`Élément #${id} introuvable dans index.html`);
      return el;
    };

    /** Arborescence d'exemple du menu Démarrer (recommandations, recherche) ; l'explorateur lit les vrais dossiers. */
    this.files = createDemoFileSystem();

    this.menus = new MenuLayer($('menus'));
    // Une fenêtre de dialogue qui s'ouvre referme le menu d'où elle vient.
    this.dialogs = new Dialogs($('dialogs'), { onOpen: () => this.menus.close() });
    this.toasts = new Toasts($('toasts'));
    this.tooltips = installTooltips($('tooltip'));
    this.flyouts = new FlyoutController($('flyouts'), {
      isMenuTarget: (node) => this.menus.contains(node),
    });
    this.wm = new WindowManager($('windows'), {
      getAnchorRect: (appId) => this.taskbar.anchorRect(appId),
    });

    this.taskbar = new Taskbar($('taskbar'), this);
    this.desktop = new Desktop($('desktop'), this);
    this.widgets = new Widgets($('widgets'));

    this.flyouts.register(new StartMenu(this));
    this.flyouts.register(new QuickSettings($('screen-fx')));
    this.flyouts.register(new NotificationCenter());

    // L'interface gère ses propres menus : pas de menu ni de glisser-déposer natifs.
    doc.addEventListener('contextmenu', (event) => event.preventDefault());
    doc.addEventListener('dragstart', (event) => event.preventDefault());
  }

  /**
   * Ouvre une application dans une fenêtre (ou réactive sa fenêtre).
   * @param {string} appId
   * @param {{ params?: any, origin?: DOMRect|null }} [options]
   *        `origin` : rectangle de l'icône cliquée, d'où la fenêtre « sort ».
   */
  launch(appId, { params, origin = null } = {}) {
    const app = getApp(appId);
    if (!app) return null;
    const alreadyOpen = Boolean(this.wm.find(appId));
    const mount = mounterFor(app.kind);
    const win = this.wm.open(app, { mount: (target, options) => mount(target, options, this), params, origin });
    if (!alreadyOpen) this.taskbar.bounce(appId);
    return win;
  }
}
