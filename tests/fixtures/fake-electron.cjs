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
const fs = require('node:fs');
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

/** Dossiers personnels connus du faux Electron : nom demandé → dossier du faux profil. */
const PERSONAL_FOLDERS = Object.freeze({
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
});

const isDirectory = (target) => {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Emplacements du compte tels que le moteur les fournit (Electron 45,
 * Chromium 156 : chrome_paths.cc, chrome_paths_win.cc) — défaut compris :
 * après avoir obtenu le chemin du dossier Documents, le moteur le crée s'il
 * n'existe pas.
 *
 *   - Windows : le chemin est demandé au système, qui vérifie que le dossier
 *     existe ; absent, la demande échoue (« Failed to get … path ») et rien
 *     n'est créé. Pour Téléchargements, le moteur se rabat alors sur
 *     « Downloads » dans Documents, sans vérifier ni créer ;
 *   - autres systèmes : le chemin est fourni sans vérification, et le dossier
 *     Documents absent est créé.
 *
 * @param {object} options
 * @param {string} options.profile     dossier du compte (les dossiers personnels s'y trouvent)
 * @param {string} [options.platform]  système imité (par défaut : celui de la machine)
 * @param {{ pathRequests: string[], unknownFolders: string[], movedFolders: Record<string, string>, createdByEngine: string[] }} options.state
 *        `pathRequests` : demandes reçues ; `unknownFolders` : dossiers que le système ne connaît pas ;
 *        `movedFolders` : dossiers déplacés hors du profil ; `createdByEngine` : dossiers créés par le moteur
 * @returns {(name: string) => string} équivalent de `app.getPath` pour « home » et les six dossiers personnels
 */
function createEnginePaths({ profile, platform = process.platform, state }) {
  const registered = (name) => state.movedFolders[name] ?? path.join(profile, PERSONAL_FOLDERS[name]);
  const failure = (name) => new Error(`Failed to get '${name}' path`);

  return function getPath(name) {
    state.pathRequests.push(name);
    if (name === 'home') return profile;
    if (!Object.hasOwn(PERSONAL_FOLDERS, name)) throw new Error(`faux moteur : emplacement inattendu « ${name} »`);
    if (state.unknownFolders.includes(name)) throw failure(name);

    const target = registered(name);
    if (platform === 'win32') {
      if (isDirectory(target)) return target;
      if (name !== 'downloads') throw failure(name);
      // Téléchargements introuvable : « Downloads » dans Documents, si Documents existe.
      if (state.unknownFolders.includes('documents') || !isDirectory(registered('documents'))) throw failure(name);
      return path.join(registered('documents'), 'Downloads');
    }
    if (name === 'documents' && !isDirectory(target)) {
      fs.mkdirSync(target, { recursive: true });
      state.createdByEngine.push(target);
    }
    return target;
  };
}

/**
 * @param {object} options
 * @param {string} options.tempDir                 dossier temporaire renvoyé par app.getPath('temp') ;
 *                                                 le dossier de configuration de l'utilisateur
 *                                                 (app.getPath('appData')) et ses dossiers personnels
 *                                                 (app.getPath('documents')…) sont placés à l'intérieur :
 *                                                 les tests ne touchent jamais au vrai profil
 * @param {string} [options.platform]              système dont le moteur imite le comportement pour les
 *                                                 dossiers personnels (voir createEnginePaths)
 * @param {boolean} [options.packaged]             application empaquetée (app.isPackaged)
 * @param {boolean} [options.lock]                 verrou d'instance unique obtenu
 * @param {{width:number,height:number}} [options.workArea]  zone de travail de l'écran principal
 * @param {Error|null} [options.loadError]         erreur renvoyée par le chargement de la page
 */
function createFakeElectron({ tempDir, platform = process.platform, packaged = true, lock = true, workArea = { width: 1920, height: 1040 }, loadError = null }) {
  const state = {
    /** Codes passés à app.exit(), dans l'ordre. */
    exitCodes: [],
    quitCalls: 0,
    /** Chemins redéfinis par app.setPath(). */
    paths: {},
    /** Emplacements du compte demandés par app.getPath() (« home » et dossiers personnels), dans l'ordre. */
    pathRequests: [],
    /** Dossiers personnels que le faux Windows ne connaît pas (app.getPath() échoue). */
    unknownFolders: [],
    /** Dossiers personnels déplacés : nom → chemin (OneDrive, autre disque…). */
    movedFolders: {},
    /** Dossiers créés par le moteur lui-même en réponse à une demande d'emplacement. */
    createdByEngine: [],
    /** Options de ligne de commande ajoutées au moteur. */
    switches: [],
    /** Fenêtres créées. */
    windows: [],
    /** Valeur passée à Menu.setApplicationMenu() (undefined = jamais appelé). */
    menu: undefined,
    permissionHandler: undefined,
    /** Écouteurs de la session (session.defaultSession.on) : événement → fonction. */
    sessionListeners: new Map(),
    /** Filtre des requêtes installé par session.webRequest.onBeforeRequest(). */
    requestFilter: undefined,
    /** Boîtes d'erreur affichées : [titre, message]. */
    errorBoxes: [],
    /** Objets exposés à la page par le script de préchargement. */
    exposed: {},
    ipcListeners: new Map(),
    ipcHandlers: new Map(),
    /** Éléments envoyés à la fausse Corbeille (shell.trashItem) : { from, to }, dans l'ordre. */
    trashed: [],
    /** Faux : la Corbeille ne peut recevoir aucun élément — Windows abandonne, rien n'est supprimé. */
    recycleBin: true,
    /** Fichiers confiés à l'application associée (shell.openPath), dans l'ordre. */
    opened: [],
    /** Texte renvoyé par shell.openPath : vide en cas de réussite, sinon la description de l'échec. */
    openResult: '',
  };

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  /** Dossiers du compte, comme le moteur les fournit — création du dossier Documents comprise. */
  const enginePaths = createEnginePaths({ profile: path.join(tempDir, 'profil'), platform, state });

  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged,
    getName: () => 'Evolve',
    getVersion: () => '9.8.7',
    getPath(name) {
      if (state.paths[name]) return state.paths[name];
      if (name === 'temp') return tempDir;
      if (name === 'appData') return path.join(tempDir, 'profil', 'AppData', 'Roaming');
      if (name === 'home' || Object.hasOwn(PERSONAL_FOLDERS, name)) return enginePaths(name);
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
        on(name, listener) {
          if (state.sessionListeners.has(name)) throw new Error(`faux electron : événement de session déjà écouté « ${name} »`);
          state.sessionListeners.set(name, listener);
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
    /**
     * Seules deux fonctions du module « shell » existent ici : l'envoi à la
     * Corbeille et l'ouverture par l'application associée. Toute autre
     * (openExternal, writeShortcutLink…) échouerait : Evolve ne s'en sert pas.
     */
    shell: {
      /** Comme Windows : l'élément quitte son dossier pour la Corbeille, ou l'opération est abandonnée et il reste en place. */
      async trashItem(target) {
        if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('faux electron : trashItem attend un chemin complet');
        if (!state.recycleBin) throw new Error('Operation was aborted');
        if (!fs.existsSync(target)) throw new Error('Failed to parse path');
        const bin = path.join(tempDir, 'corbeille');
        fs.mkdirSync(bin, { recursive: true });
        const to = path.join(bin, `${state.trashed.length + 1}-${path.basename(target)}`);
        fs.renameSync(target, to);
        state.trashed.push({ from: target, to });
      },
      /** Comme Electron : la promesse renvoie un texte vide, ou la description de l'échec. */
      async openPath(target) {
        if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('faux electron : openPath attend un chemin complet');
        state.opened.push(target);
        return state.openResult;
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

module.exports = { createFakeElectron, createEnginePaths, cancellable, PERSONAL_FOLDERS };
