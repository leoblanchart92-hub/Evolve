'use strict';

/**
 * Evolve — Processus principal (Electron).
 *
 * Ouvre une fenêtre plein écran qui affiche l'environnement de bureau Evolve
 * et la relie à la couche de services (src/services/), indépendante de
 * l'interface.
 *   - aucun droit administrateur n'est demandé ;
 *   - aucun paramètre de Windows n'est modifié ;
 *   - rien n'est installé : les fichiers de travail (cache du moteur de rendu)
 *     sont placés dans le dossier temporaire de l'utilisateur ;
 *   - les réglages de l'utilisateur sont conservés dans un seul fichier,
 *     %APPDATA%\Evolve\settings.json, créé au premier réglage modifié ;
 *   - les dossiers de l'ordinateur sont consultés en lecture seule par
 *     l'explorateur de fichiers (service « files ») : Windows est seulement
 *     interrogé sur l'emplacement des dossiers personnels (Bureau, Documents…),
 *     et aucun dossier n'est jamais créé — un dossier absent le reste
 *     (voir personal-folders.js).
 *
 * Options de la ligne de commande : voir args.js.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require('electron');

const { parseArgs } = require('./args');
const { personalFolders } = require('./personal-folders');
const { createServices } = require('../services');
const { settingsDir, settingsFile } = require('../services/platform');

const options = parseArgs(process.argv);

const RENDERER_ENTRY = path.join(__dirname, '..', 'renderer', 'index.html');
const BACKGROUND = '#05020c';
/** Délai au-delà duquel la fenêtre est affichée même sans premier rendu signalé. */
const REVEAL_TIMEOUT_MS = 5000;
/** Adresses réseau : l'interface, entièrement locale, n'en appelle jamais aucune. */
const NETWORK_URL = /^(?:https?|wss?|ftp):/i;
const devToolsAllowed = options.devtools || !app.isPackaged;
/** Origine des demandes venues de la fenêtre (voir registerIpc). */
const WINDOW_ORIGIN = 'window';

/** Dépôt où les versions d'Evolve sont publiées (voir le service « updates »). */
const REPOSITORY = Object.freeze({ owner: 'leoblanchart92-hub', name: 'Evolve' });
/** Seules adresses qu'Evolve accepte d'ouvrir dans le navigateur du système. */
const EXTERNAL_URL = new RegExp(`^https://github\\.com/${REPOSITORY.owner}/${REPOSITORY.name}/(?:releases|tree|blob|issues)\\b`);
/** Dossier du téléchargement d'une mise à jour, dans le dossier temporaire. */
const UPDATE_DIR_NAME = 'Evolve-mise-a-jour';
/** Dossier de l'application : celui de l'exécutable, ou la racine du projet. */
const APP_DIR = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');
/** Nom lisible du système d'exploitation. */
const PLATFORM_NAMES = Object.freeze({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' });
/** Nom lisible du type d'installation (portable, pour vous, pour tous…). */
const INSTALL_LABELS = Object.freeze({
  portable: 'Version portable',
  user: 'Installé pour vous',
  machine: 'Installé pour tous les utilisateurs',
  development: 'Développement',
});
/** Arguments d'installation silencieuse d'un installateur (voir launchInstaller). */
const SETUP_ARGS = ['/S', '--updated'];

/** @type {BrowserWindow|null} */
let mainWindow = null;
/**
 * Couche de services (réglages…). Créée seulement par l'instance qui garde
 * la main : un second lancement ne touche jamais au fichier des réglages.
 * @type {ReturnType<typeof createServices>|null}
 */
let services = null;

/**
 * Chemin d'un fichier ou d'un dossier demandé sur la ligne de commande.
 * L'exécutable portable se décompresse dans un dossier temporaire supprimé à
 * la fermeture : un chemin relatif part donc du dossier du fichier .exe.
 */
function fromLaunchDir(target) {
  return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR || process.cwd(), target);
}

/** Dossier des résultats de l'auto-test (rapport et captures d'écran). */
function selfTestOutputDir() {
  return fromLaunchDir(options.selfTestDir || 'self-test-output');
}

/**
 * Auto-test : une erreur fatale est consignée dans le dossier des résultats
 * puis l'application s'arrête en échec. Sans cela, l'erreur resterait
 * invisible (pas de console) ou bloquerait la compilation sur une boîte de
 * dialogue que personne ne peut fermer.
 */
function abortSelfTest(error) {
  try {
    const dir = selfTestOutputDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'fatal-error.log'), `${(error && error.stack) || error}\n`);
  } catch {
    /* rien de plus à faire : le code de sortie signale l'échec */
  }
  exitNow(1);
}

/**
 * Arrêt immédiat. `app.exit` n'émet aucun événement de fermeture : les
 * réglages en attente sont donc enregistrés ici.
 */
function exitNow(code) {
  if (services) services.flushSync();
  app.exit(code);
}

/**
 * Fichier des réglages de l'utilisateur :
 *   --settings-dir=DOSSIER   dans le dossier demandé ;
 *   auto-test                aucun fichier : les réglages restent en mémoire,
 *                            ceux de l'utilisateur ne sont ni lus ni modifiés ;
 *   sinon                    dans le dossier de configuration de l'utilisateur
 *                            (%APPDATA%\Evolve sous Windows).
 */
function resolveSettingsFile() {
  if (options.settingsDir) return settingsFile(fromLaunchDir(options.settingsDir));
  if (options.selfTest) return null;
  return settingsFile(settingsDir({ appData: app.getPath('appData') }));
}

/** Fichier des réglages de cette exécution (`null` : réglages en mémoire). */
const settingsFilePath = resolveSettingsFile();

/**
 * Façon dont Evolve est lancé. Elle détermine le fichier proposé à la mise à
 * jour : un exécutable portable ne se remplace pas lui-même.
 * @returns {'portable'|'user'|'machine'|'development'}
 */
function installKind() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  if (!app.isPackaged) return 'development';
  // Une installation pour tous les utilisateurs range l'application dans
  // « Program Files » ; celle d'un seul utilisateur, dans son propre dossier.
  return /[\\/]program files[\\/]/i.test(APP_DIR) ? 'machine' : 'user';
}

/** Ce que l'application sait d'elle-même (service « system », en lecture seule). */
function systemInfo() {
  const kind = installKind();
  return {
    app: app.getName(),
    version: app.getVersion(),
    install: { kind, label: INSTALL_LABELS[kind] ?? kind, dir: APP_DIR },
    platform: { name: PLATFORM_NAMES[process.platform] ?? process.platform, arch: process.arch, release: os.release() },
    storage: settingsFilePath ? 'file' : 'memory',
    paths: {
      settings: settingsFilePath ? path.dirname(settingsFilePath) : null,
      data: app.getPath('userData'),
      install: app.isPackaged ? APP_DIR : null,
    },
    versions: {
      electron: process.versions.electron ?? null,
      node: process.versions.node ?? null,
      chrome: process.versions.chrome ?? null,
    },
  };
}

/**
 * Lance l'installateur d'une mise à jour déjà vérifiée, puis laisse Evolve se
 * fermer pour que le fichier puisse être remplacé.
 *
 * Une installation pour tous les utilisateurs demande les droits
 * d'administrateur : Windows affiche alors sa propre demande. Rien n'est
 * lancé en silence à l'insu de l'utilisateur.
 *
 * @param {string} file
 * @param {{ channel: string, version: string }} meta
 * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
 */
function launchInstaller(file, { channel }) {
  /** Attente maximale avant de considérer que le lancement a réussi. */
  const GRACE_MS = 6000;
  const outcome = new Promise((resolve) => {
    const child =
      channel === 'machine'
        ? spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath "${file}" -ArgumentList '${SETUP_ARGS.join("','")}' -Verb RunAs`],
            { detached: true, stdio: 'ignore', windowsHide: true },
          )
        : spawn(file, SETUP_ARGS, { detached: true, stdio: 'ignore' });

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle({ ok: true }), GRACE_MS);
    child.on('error', (error) => settle({ ok: false, code: 'not-launched', message: `L'installation n'a pas pu être lancée : ${error?.message ?? error}` }));
    child.on('exit', (code) => settle(code === 0 || code === null ? { ok: true } : { ok: false, code: 'not-launched', message: `L'installation s'est arrêtée (code ${code}).` }));
    child.unref();
  });
  return outcome;
}

/** Configuration du service des mises à jour ; désactivée pendant les vérifications automatiques. */
function updatesConfig() {
  if (options.selfTest || options.statusFile || options.settingsDir) return {};
  return {
    channel: installKind() === 'development' ? 'user' : installKind(),
    repo: REPOSITORY,
    downloadDir: path.join(tempDir, UPDATE_DIR_NAME),
    launch: launchInstaller,
    fetchImpl: globalThis.fetch,
  };
}

/** Vérification silencieuse au démarrage : une seule fois par lancement, sans jamais rien écrire. */
async function checkForUpdatesOnStart() {
  if (!services || !updatesConfig().channel) return;
  try {
    if (services.settings.get('updates.autoCheck') !== true) return;
    await services.updates.check({});
  } catch (error) {
    console.warn(`Mises à jour : vérification impossible au démarrage : ${error?.message ?? error}`);
  }
}

/**
 * Dossiers personnels de l'utilisateur (Bureau, Documents, Téléchargements,
 * Images, Musique, Vidéos), tels que Windows les indique : ils peuvent avoir
 * été déplacés, vers OneDrive par exemple. Demandés à la première ouverture
 * de l'explorateur — jamais au démarrage — et sans que rien ne soit créé : un
 * dossier absent est signalé comme introuvable. Il est seul redemandé aux
 * recherches suivantes (`known` : emplacements déjà obtenus), au cas où il
 * serait revenu.
 */
function locatePersonalFolders(known) {
  return personalFolders({ getPath: (name) => app.getPath(name), known });
}

/**
 * Module de fichiers d'origine de Node : celui d'Electron présente les
 * archives .asar comme des dossiers, ce qu'un explorateur ne doit pas faire.
 */
function plainFileSystem() {
  try {
    return require('original-fs');
  } catch {
    return fs; // hors d'Electron (tests)
  }
}

if (options.selfTest) {
  process.on('uncaughtException', abortSelfTest);
  process.on('unhandledRejection', abortSelfTest);
}

// Les données de travail du moteur de rendu (cache) vont dans le dossier
// temporaire : le profil de l'utilisateur ne reçoit que le fichier des
// réglages (voir resolveSettingsFile). L'auto-test utilise un dossier
// distinct pour ne jamais interférer avec une session ouverte.
const tempDir = app.getPath('temp');
const userData = path.join(tempDir, options.selfTest ? 'Evolve-autotest' : 'Evolve');
try {
  fs.mkdirSync(userData, { recursive: true });
} catch {
  /* le moteur de rendu créera le dossier lui-même */
}
app.setPath('userData', userData);

if (options.selfTest) {
  // L'auto-test doit continuer à dessiner l'interface même si sa fenêtre est
  // masquée par une autre ou si l'écran de la machine de compilation est éteint.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// Une seule instance à la fois : un second lancement réactive la fenêtre.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  // Un auto-test qui ne s'exécute pas ne doit jamais passer pour une réussite.
  if (options.selfTest) abortSelfTest(new Error("Un auto-test d'Evolve est déjà en cours."));
  else app.exit(0);
} else {
  services = createServices({
    settingsFile: settingsFilePath,
    appVersion: app.getVersion(),
    // Explorateur de fichiers : dossiers personnels et lecteurs locaux, en lecture seule.
    files: { places: locatePersonalFolders, drives: 'auto', fs: plainFileSystem() },
    // Ce que l'application sait d'elle-même ; ouverture d'un dossier par le système.
    system: { info: systemInfo, open: async (_target, folder) => (await shell.openPath(folder)) || null },
    // Mises à jour : désactivées pendant les vérifications automatiques.
    updates: updatesConfig(),
    log: (message) => console.warn(message),
  });
  // Événements des services : transmis à la fenêtre, sauf ceux qui découlent
  // de ses propres demandes (elle en connaît déjà le résultat).
  services.hub.subscribe(({ service, event, payload, origin }) => {
    if (origin === WINDOW_ORIGIN || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('evolve:service-event', { service, event, payload });
  });
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

/** Taille de la fenêtre hors plein écran : 16:9, adaptée à l'écran. */
function windowedSize() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.max(960, Math.min(1600, Math.round(width * 0.9))),
    height: Math.max(600, Math.min(900, Math.round(height * 0.9))),
  };
}

function createWindow() {
  const win = new BrowserWindow({
    ...windowedSize(),
    minWidth: 960,
    minHeight: 600,
    useContentSize: true,
    center: true,
    show: false,
    fullscreen: !options.windowed && !options.selfTest,
    title: app.getName(),
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: devToolsAllowed,
      backgroundThrottling: !options.selfTest,
    },
  });
  mainWindow = win;

  const { webContents } = win;

  // --- Sécurité : l'interface est locale et ne navigue jamais ailleurs. ------
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.on('will-attach-webview', (event) => event.preventDefault());

  // Le zoom par pincement déformerait la mise en page de l'environnement.
  webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // --- Raccourcis clavier ------------------------------------------------------
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (input.key === 'F12' && devToolsAllowed) {
      event.preventDefault();
      webContents.toggleDevTools();
    }
  });

  // --- Plein écran : l'interface est tenue informée ---------------------------
  const notifyFullscreen = () => {
    if (!win.isDestroyed()) webContents.send('evolve:fullscreen-changed', win.isFullScreen());
  };
  win.on('enter-full-screen', notifyFullscreen);
  win.on('leave-full-screen', notifyFullscreen);

  // --- Affichage -------------------------------------------------------------
  // La fenêtre apparaît dès que son premier rendu est prêt (pas d'écran blanc).
  // Garde-fous : elle apparaît aussi à la fin du chargement et, au plus tard,
  // après quelques secondes — jamais d'application lancée mais invisible.
  const reveal = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', reveal);
  webContents.once('did-finish-load', reveal);
  const revealTimer = setTimeout(reveal, REVEAL_TIMEOUT_MS);

  win.on('closed', () => {
    clearTimeout(revealTimer);
    mainWindow = null;
  });

  // Arrêt de l'ordinateur ou fermeture de la session Windows : l'application
  // peut être interrompue sans autre préavis.
  win.on('session-end', () => {
    if (services) services.flushSync();
  });

  // --- Incidents (hors auto-test, qui les consigne lui-même) -----------------
  if (!options.selfTest) {
    // Le moteur de rendu s'est arrêté : on recharge une fois, puis on renonce.
    let crashes = 0;
    webContents.on('render-process-gone', (_event, details) => {
      if (win.isDestroyed() || (details && details.reason === 'clean-exit')) return;
      crashes += 1;
      if (crashes === 1) webContents.reload();
      else fail("L'affichage d'Evolve s'est arrêté de façon inattendue.");
    });
  }

  win.loadFile(RENDERER_ENTRY).catch((error) => {
    if (!options.selfTest) fail(`Impossible de charger l'interface d'Evolve.\n\n${(error && error.message) || error}`);
  });
  return win;
}

/** Signale une erreur irrécupérable à l'utilisateur puis ferme l'application. */
function fail(message) {
  dialog.showErrorBox(app.getName(), message);
  exitNow(1);
}

/** N'accepte que les messages provenant de la fenêtre de l'application. */
function fromMainWindow(event) {
  return Boolean(mainWindow) && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

function registerIpc() {
  ipcMain.on('evolve:quit', (event) => {
    if (fromMainWindow(event)) app.quit();
  });

  ipcMain.handle('evolve:toggle-fullscreen', (event) => {
    if (!fromMainWindow(event)) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });

  ipcMain.handle('evolve:is-fullscreen', (event) => (fromMainWindow(event) ? mainWindow.isFullScreen() : false));

  // Ouvre une adresse dans le navigateur du système. Seules les pages du
  // projet sont acceptées : aucune autre adresse n'est transmise à Windows.
  ipcMain.handle('evolve:open-external', (event, url) => {
    if (!fromMainWindow(event)) return false;
    if (typeof url !== 'string' || !EXTERNAL_URL.test(url)) return false;
    shell.openExternal(url).catch(() => {});
    return true;
  });

  // Services d'Evolve : la page désigne une méthode par son nom ; le point
  // d'accès contrôle la demande et répond toujours sous la forme { ok, … }.
  ipcMain.handle('evolve:service-call', (event, service, method, args) => {
    if (!fromMainWindow(event) || !services) return { ok: false, code: 'forbidden', message: 'Appel refusé.' };
    return services.hub.call(service, method, args, { origin: WINDOW_ORIGIN });
  });
}

async function start() {
  // Pas de barre de menus native : l'environnement fournit sa propre interface.
  Menu.setApplicationMenu(null);

  // L'interface n'a besoin d'aucune autorisation (caméra, micro, position…).
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  // Elle est entièrement locale : toute requête vers le réseau est refusée.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: NETWORK_URL.test(details.url) });
  });

  // Elle n'enregistre aucun fichier : un téléchargement, d'où qu'il vienne,
  // est annulé avant que rien ne soit écrit sur le disque.
  session.defaultSession.on('will-download', (event) => event.preventDefault());

  registerIpc();
  const win = createWindow();

  // Une seule vérification silencieuse, un peu après le démarrage : elle ne
  // doit jamais retarder l'affichage du bureau.
  if (!options.selfTest && !options.statusFile && !options.settingsDir) {
    setTimeout(checkForUpdatesOnStart, 6000);
  }

  if (options.selfTest) {
    // Chargé à la demande : l'auto-test ne sert qu'à la compilation automatique.
    const { runSelfTest } = require('./selftest');
    const exitCode = await runSelfTest(win, {
      outDir: selfTestOutputDir(),
      scenario: options.selfTestScenario || undefined,
      describeServices: () => services.describe(),
    });
    exitNow(exitCode === 0 ? 0 : 1);
  } else if (options.statusFile) {
    // Chargé à la demande : ne sert qu'à vérifier le lancement de l'exécutable.
    // Un compte rendu impossible à écrire ne doit pas gêner l'application.
    const { reportStatus } = require('./status');
    reportStatus(win, {
      file: fromLaunchDir(options.statusFile),
      screen,
      userData: app.getPath('userData'),
      describeServices: () => services.describe(),
    }).catch(() => {});
  }
}

if (hasLock) {
  app.whenReady().then(start).catch((error) => {
    if (options.selfTest) abortSelfTest(error);
    else fail(`Evolve n'a pas pu démarrer.\n\n${(error && error.message) || error}`);
  });
}

app.on('window-all-closed', () => {
  // Pendant l'auto-test, c'est le test qui décide du code de sortie.
  if (!options.selfTest) app.quit();
});

// Fermeture normale : un réglage modifié à l'instant est enregistré avant l'arrêt.
app.on('will-quit', () => {
  if (services) services.flushSync();
});

// Aucune fenêtre secondaire pour tout contenu créé par la suite.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
