'use strict';

/**
 * Evolve — Processus principal (Electron).
 *
 * Ouvre une fenêtre plein écran qui affiche l'environnement de bureau Evolve
 * et la relie à la couche de services (src/services/), indépendante de
 * l'interface.
 *   - aucun droit administrateur n'est demandé ;
 *   - aucun paramètre de Windows n'est lu ni modifié ;
 *   - rien n'est installé : les fichiers de travail (cache du moteur de rendu)
 *     sont placés dans le dossier temporaire de l'utilisateur ;
 *   - les réglages de l'utilisateur sont conservés dans un seul fichier,
 *     %APPDATA%\Evolve\settings.json, créé au premier réglage modifié.
 *
 * Options de la ligne de commande : voir args.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session } = require('electron');

const { parseArgs } = require('./args');
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

if (options.selfTest) {
  process.on('uncaughtException', abortSelfTest);
  process.on('unhandledRejection', abortSelfTest);
}

// Les données de travail du moteur de rendu (cache) vont dans le dossier
// temporaire : le profil de l'utilisateur ne reçoit que le fichier des
// réglages (voir resolveSettingsFile). L'auto-test utilise un dossier
// distinct pour ne jamais interférer avec une session ouverte.
const userData = path.join(app.getPath('temp'), options.selfTest ? 'Evolve-autotest' : 'Evolve');
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
    settingsFile: resolveSettingsFile(),
    appVersion: app.getVersion(),
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

  registerIpc();
  const win = createWindow();

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
