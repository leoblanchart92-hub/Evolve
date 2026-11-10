'use strict';

/**
 * Faux module « electron » pour les tests.
 *
 * Il permet d'exécuter le processus principal (src/main/main.js) et le script
 * de préchargement avec Node seul, sans moteur de rendu : il consigne ce que
 * l'application demande (fenêtres, options, canaux, arrêt) et permet de
 * déclencher les événements qu'Electron émettrait.
 *
 * Il ne reproduit que les API utilisées par Evolve ; toute autre utilisation
 * échoue, ce qui signale qu'un test doit être complété.
 */

const { EventEmitter } = require('node:events');
const path = require('node:path');

/** Événement annulable, comme ceux d'Electron. */
function cancellable() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.tempDir                 dossier temporaire renvoyé par app.getPath('temp') ;
 *                                                 le dossier de configuration de l'utilisateur
 *                                                 (app.getPath('appData')) est placé à l'intérieur :
 *                                                 les tests n'écrivent jamais dans le vrai profil
 * @param {boolean} [options.packaged]             application empaquetée (app.isPackaged)
 * @param {boolean} [options.lock]                 verrou d'instance unique obtenu
 * @param {{width:number,height:number}} [options.workArea]  zone de travail de l'écran principal
 * @param {Error|null} [options.loadError]         erreur renvoyée par le chargement de la page
 */
function createFakeElectron({ tempDir, packaged = true, lock = true, workArea = { width: 1920, height: 1040 }, loadError = null }) {
  const state = {
    /** Codes passés à app.exit(), dans l'ordre. */
    exitCodes: [],
    quitCalls: 0,
    /** Chemins redéfinis par app.setPath(). */
    paths: {},
    /** Options de ligne de commande ajoutées au moteur. */
    switches: [],
    /** Fenêtres créées. */
    windows: [],
    /** Valeur passée à Menu.setApplicationMenu() (undefined = jamais appelé). */
    menu: undefined,
    permissionHandler: undefined,
    /** Filtre des requêtes installé par session.webRequest.onBeforeRequest(). */
    requestFilter: undefined,
    /** Boîtes d'erreur affichées : [titre, message]. */
    errorBoxes: [],
    /** Objets exposés à la page par le script de préchargement. */
    exposed: {},
    ipcListeners: new Map(),
    ipcHandlers: new Map(),
  };

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged,
    getName: () => 'Evolve',
    getVersion: () => '9.8.7',
    getPath(name) {
      if (state.paths[name]) return state.paths[name];
      if (name === 'temp') return tempDir;
      if (name === 'appData') return path.join(tempDir, 'profil', 'AppData', 'Roaming');
      throw new Error(`faux electron : chemin inattendu « ${name} »`);
    },
    setPath(name, value) {
      state.paths[name] = value;
    },
    commandLine: {
      appendSwitch(name, value) {
        state.switches.push(value === undefined ? name : `${name}=${value}`);
      },
    },
    requestSingleInstanceLock: () => lock,
    whenReady: () => readyPromise,
    quit() {
      state.quitCalls += 1;
    },
    exit(code = 0) {
      state.exitCodes.push(code);
    },
  });

  class FakeWebContents extends EventEmitter {
    sent = [];
    devToolsToggles = 0;
    reloads = 0;
    openHandler = null;
    zoomLimits = null;
    /** Abonnements de la page (ipcRenderer.on). */
    rendererListeners = new Map();

    setWindowOpenHandler(handler) {
      this.openHandler = handler;
    }

    setVisualZoomLevelLimits(minimum, maximum) {
      this.zoomLimits = [minimum, maximum];
      return Promise.resolve();
    }

    send(channel, ...args) {
      this.sent.push([channel, ...args]);
      for (const listener of this.rendererListeners.get(channel) ?? []) listener({ sender: null }, ...args);
    }

    toggleDevTools() {
      this.devToolsToggles += 1;
    }

    reload() {
      this.reloads += 1;
    }

    executeJavaScript() {
      return Promise.resolve(true);
    }
  }

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.visible = options.show !== false;
      this.fullScreen = Boolean(options.fullscreen);
      this.minimized = false;
      this.destroyed = false;
      this.showCalls = 0;
      this.focusCalls = 0;
      this.loadedFile = null;
      state.windows.push(this);
      app.emit('web-contents-created', {}, this.webContents);
    }

    loadFile(file) {
      this.loadedFile = file;
      return loadError ? Promise.reject(loadError) : Promise.resolve();
    }

    show() {
      this.visible = true;
      this.showCalls += 1;
    }

    isVisible() {
      return this.visible;
    }

    isDestroyed() {
      return this.destroyed;
    }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.minimized = false;
    }

    focus() {
      this.focusCalls += 1;
    }

    isFullScreen() {
      return this.fullScreen;
    }

    setFullScreen(value) {
      if (this.fullScreen === Boolean(value)) return;
      this.fullScreen = Boolean(value);
      this.emit(this.fullScreen ? 'enter-full-screen' : 'leave-full-screen');
    }

    getContentBounds() {
      return { x: 0, y: 0, width: this.options.width, height: this.options.height };
    }

    capturePage() {
      return Promise.resolve({ isEmpty: () => false, toPNG: () => Buffer.from('image') });
    }

    /** Simule la fermeture de la fenêtre par l'utilisateur. */
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }

  const ipcMain = {
    on(channel, listener) {
      if (state.ipcListeners.has(channel)) throw new Error(`faux electron : canal déjà écouté « ${channel} »`);
      state.ipcListeners.set(channel, listener);
    },
    handle(channel, handler) {
      if (state.ipcHandlers.has(channel)) throw new Error(`faux electron : canal déjà traité « ${channel} »`);
      state.ipcHandlers.set(channel, handler);
    },
  };

  /** Côté page : un `ipcRenderer` dont les messages proviennent de `webContents`. */
  function rendererFor(webContents) {
    return {
      send(channel, ...args) {
        const listener = state.ipcListeners.get(channel);
        if (!listener) throw new Error(`faux electron : aucun écouteur pour « ${channel} »`);
        listener({ sender: webContents }, ...args);
      },
      invoke(channel, ...args) {
        const handler = state.ipcHandlers.get(channel);
        if (!handler) return Promise.reject(new Error(`No handler registered for '${channel}'`));
        // Comme le vrai canal : arguments et résultat sont copiés, jamais partagés ;
        // ce qui ne peut pas être copié (une fonction…) fait échouer l'appel.
        return Promise.resolve()
          .then(() => handler({ sender: webContents }, ...structuredClone(args)))
          .then((result) => structuredClone(result));
      },
      on(channel, listener) {
        const list = webContents.rendererListeners.get(channel) ?? [];
        webContents.rendererListeners.set(channel, [...list, listener]);
      },
      removeListener(channel, listener) {
        const list = webContents.rendererListeners.get(channel) ?? [];
        webContents.rendererListeners.set(
          channel,
          list.filter((item) => item !== listener),
        );
      },
    };
  }

  /** L'objet renvoyé par require('electron'). */
  const electron = {
    app,
    BrowserWindow,
    ipcMain,
    Menu: {
      setApplicationMenu(menu) {
        state.menu = menu;
      },
    },
    dialog: {
      showErrorBox(title, message) {
        state.errorBoxes.push([title, message]);
      },
    },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { ...workArea } }),
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler(handler) {
          state.permissionHandler = handler;
        },
        webRequest: {
          onBeforeRequest(...args) {
            // Signature d'Electron : ([filtre, ]écouteur).
            state.requestFilter = args.at(-1);
            state.requestFilterUrls = args.length > 1 ? args[0] : null;
          },
        },
      },
    },
    contextBridge: {
      exposeInMainWorld(name, api) {
        if (name in state.exposed) throw new Error(`faux electron : « ${name} » déjà exposé`);
        state.exposed[name] = api;
      },
    },
    /** Remplacé par `rendererFor(...)` avant de charger le script de préchargement. */
    ipcRenderer: null,
  };

  return {
    electron,
    state,
    app,
    cancellable,
    rendererFor,
    /** Signale que l'application est prête (événement « ready » d'Electron). */
    ready: () => resolveReady(),
  };
}

module.exports = { createFakeElectron, cancellable };
