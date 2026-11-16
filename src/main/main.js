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
 *   - les dossiers de l'ordinateur sont consultés par l'explorateur de
 *     fichiers (service « files », en lecture seule) : Windows est seulement
 *     interrogé sur l'emplacement des dossiers personnels (Bureau, Documents…),
 *     et aucun dossier personnel n'est jamais créé — un dossier absent le reste
 *     (voir personal-folders.js) ;
 *   - les fichiers de l'utilisateur ne sont modifiés qu'à sa demande, par les
 *     opérations de src/services/file-operations.js (nouveau dossier, renommer,
 *     copier, déplacer). Ce processus leur fournit trois fonctions de Windows
 *     et rien d'autre : l'envoi à la Corbeille — seule forme de suppression,
 *     sans repli vers une suppression définitive —, l'ouverture d'un fichier
 *     par l'application associée, et le déplacement sans remplacement, que
 *     Windows refuse de lui-même si le nom d'arrivée est déjà pris (voir
 *     atomic-move.js). La fenêtre n'accède jamais au système de fichiers :
 *     elle demande chaque opération par un canal qui lui est propre ;
 *   - seule la version installée (Evolve-Setup) se met à jour : elle
 *     interroge la page où Evolve est publié, et ne télécharge ni n'installe
 *     rien sans demande (voir services/updates.js et update-engine.js).
 *     L'exécutable portable, lui, ne se connecte jamais au réseau.
 *
 * Options de la ligne de commande : voir args.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require('electron');

const { parseArgs } = require('./args');
const { loadAtomicMove } = require('./atomic-move');
const { personalFolders } = require('./personal-folders');
const { createUpdateEngine } = require('./update-engine');
const { detectVariant } = require('./variant');
const { createServices } = require('../services');
const { AGENDA_FILE } = require('../services/agenda');
const { NOTES_FILE } = require('../services/notes');
const { dataFile, settingsDir, settingsFile } = require('../services/platform');
const { compareVersions, localFeed, productionFeed } = require('../services/updates');

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
/** Délai entre l'affichage de l'interface et la recherche d'une mise à jour faite au lancement. */
const UPDATE_CHECK_DELAY_MS = 8000;

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

/**
 * Envoie un élément à la Corbeille de Windows — la seule forme de suppression
 * qu'Evolve connaisse. Si la Corbeille ne peut pas recevoir l'élément, Windows
 * abandonne l'opération et la promesse est rejetée : il n'existe aucun repli
 * vers une suppression définitive, ni ici ni ailleurs.
 * @param {string} location  chemin réel, déjà contrôlé par le service
 * @returns {Promise<void>}
 */
function sendToRecycleBin(location) {
  return shell.trashItem(location);
}

/**
 * Confie un fichier à l'application que Windows lui associe. Evolve ne lit
 * pas le fichier et n'en exécute rien lui-même.
 * @param {string} location  chemin réel, déjà contrôlé par le service
 * @returns {Promise<string>} texte vide, ou la description de l'échec
 */
function openWithAssociatedApp(location) {
  return shell.openPath(location);
}

/**
 * Fonction qui renomme ou déplace un élément sans jamais rien remplacer :
 * Windows refuse de lui-même si le nom d'arrivée est déjà pris, d'un seul
 * geste — aucun autre programme ne peut s'intercaler (voir atomic-move.js).
 * Si elle ne peut pas être chargée, RIEN NE LA REMPLACE : sans elle, les
 * opérations sur les fichiers refusent de renommer et de déplacer.
 * @type {((from: string, to: string) => Promise<void>) | null}
 */
let moveNoReplace = null;

/**
 * Raison pour laquelle cette fonction n'a pas pu être chargée, ou `null`. Un
 * auto-test s'arrête alors en échec : un exécutable qui ne saurait ni
 * renommer ni déplacer ne doit pas être publié.
 * @type {Error|null}
 */
let moveNoReplaceFailure = null;

try {
  moveNoReplace = loadAtomicMove();
} catch (error) {
  moveNoReplaceFailure = error instanceof Error ? error : new Error(String(error));
  console.warn(`${moveNoReplaceFailure.message} — renommer et déplacer sont désactivés.`);
}

/**
 * Requêtes réseau du moteur des mises à jour — les seules que l'application
 * émette. Elles passent par une session à part, distincte de celle de
 * l'interface (où toute requête vers le réseau reste refusée), créée à la
 * première requête. Rien n'y est conservé d'un lancement à l'autre, et toute
 * adresse que la voie de publication n'admet pas y est refusée, à chaque
 * étape d'une requête, redirections comprises : le moteur n'indique pas
 * l'adresse d'où vient une réponse, c'est donc ici que la règle s'applique.
 *
 * @param {{ admits: (address: string) => boolean }} feed  voie de publication (voir services/updates.js)
 * @returns {(url: string, init: object) => Promise<Response>}
 */
function createUpdateRequest(feed) {
  let updateSession = null;
  return (url, init) => {
    if (!updateSession) {
      updateSession = session.fromPartition('evolve-mises-a-jour', { cache: false });
      updateSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      updateSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: feed.admits(details.url) !== true });
      });
      updateSession.on('will-download', (event) => event.preventDefault());
    }
    return updateSession.fetch(url, init);
  };
}

/** Moteur des mises à jour, ou `null` : seule la version installée en a un. */
let updateEngine = null;

/**
 * Ce que l'hôte fournit au service des mises à jour. Seule la version
 * installée reçoit un moteur ; les autres ne peuvent rien rechercher.
 * @param {string} variant  façon dont Evolve a été lancé (voir variant.js)
 */
function updateOptions(variant) {
  if (variant !== 'installed') return { variant };
  // Vérification automatique de la mise à jour : un serveur de cette machine tient lieu de page de publication.
  const feed = options.updateFeed ? localFeed(options.updateFeed) : productionFeed();
  if (!feed) {
    console.warn("Adresse d'essai des mises à jour refusée : seule une adresse de cette machine (127.0.0.1) est admise.");
    return { variant };
  }
  updateEngine = createUpdateEngine({ feed, request: createUpdateRequest(feed), tempDir: app.getPath('temp'), log: (message) => console.warn(message) });
  return { variant, engine: updateEngine, page: feed.page, updated: options.updated, quit: () => app.quit() };
}

/**
 * Processus d'Evolve, pour le Moniteur système : nature, processeur (en
 * pourcentage d'un cœur) et mémoire (en octets) de chacun. Lecture seule.
 */
function evolveProcesses() {
  return app.getAppMetrics().map((metric) => ({
    type: metric.type,
    name: metric.name || metric.serviceName || null,
    pid: metric.pid,
    cpu: metric.cpu ? metric.cpu.percentCPUUsage : null,
    // Electron compte la mémoire en kilo-octets.
    memory: metric.memory ? metric.memory.workingSetSize * 1024 : null,
  }));
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
  const userSettingsFile = resolveSettingsFile();
  // Notes et agenda : à côté des réglages. Sans fichier de réglages (auto-test), ils restent en mémoire.
  const dataDir = userSettingsFile ? path.dirname(userSettingsFile) : null;
  services = createServices({
    settingsFile: userSettingsFile,
    notesFile: dataDir ? dataFile(dataDir, NOTES_FILE) : null,
    agendaFile: dataDir ? dataFile(dataDir, AGENDA_FILE) : null,
    appVersion: app.getVersion(),
    // Système : ce que l'hôte sait de lui-même ; les mesures de la machine sont lues par le service.
    system: { dataDir, versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }, processes: evolveProcesses },
    // Explorateur de fichiers : dossiers personnels et lecteurs locaux.
    files: { places: locatePersonalFolders, drives: 'auto', fs: plainFileSystem() },
    // Opérations sur les fichiers : la Corbeille, l'ouverture et le déplacement sans remplacement
    // sont confiés à Windows.
    operations: { trash: sendToRecycleBin, openPath: openWithAssociatedApp, moveNoReplace },
    // Mises à jour : version installée seulement.
    updates: updateOptions(detectVariant({ packaged: app.isPackaged })),
    log: (message) => console.warn(message),
  });
  // Événements des services : transmis à la fenêtre, sauf ceux qui découlent
  // de ses propres demandes (elle en connaît déjà le résultat).
  services.hub.subscribe(({ service, event, payload, origin }) => {
    if (origin === WINDOW_ORIGIN || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('evolve:service-event', { service, event, payload });
  });
  // Progression des opérations sur les fichiers (copie d'un gros dossier…).
  services.fileOperations.onProgress((progress) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('evolve:files-progress', progress);
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

  // Opérations sur les fichiers : un canal par opération, aux arguments fixés.
  // Aucune n'est une méthode d'un service : le canal ci-dessus ne peut en
  // atteindre aucune. Chaque demande doit venir de la fenêtre de
  // l'application ; les chemins sont contrôlés par le service, avant tout accès.
  const refused = () => ({ ok: false, code: 'forbidden', message: 'Appel refusé.' });
  const trusted = (event) => fromMainWindow(event) && Boolean(services);

  ipcMain.handle('evolve:files-create-folder', (event, parent, name) => (trusted(event) ? services.fileOperations.createFolder(parent, name) : refused()));
  ipcMain.handle('evolve:files-rename', (event, target, name) => (trusted(event) ? services.fileOperations.rename(target, name) : refused()));
  ipcMain.handle('evolve:files-copy', (event, sources, destination, choices) => (trusted(event) ? services.fileOperations.copy(sources, destination, choices) : refused()));
  ipcMain.handle('evolve:files-move', (event, sources, destination, choices) => (trusted(event) ? services.fileOperations.move(sources, destination, choices) : refused()));
  ipcMain.handle('evolve:files-trash', (event, targets, choices) => (trusted(event) ? services.fileOperations.trash(targets, choices) : refused()));
  ipcMain.handle('evolve:files-open', (event, target, choices) => (trusted(event) ? services.fileOperations.open(target, choices) : refused()));
  ipcMain.handle('evolve:files-cancel', (event, operation) => (trusted(event) ? services.fileOperations.cancel(operation) : refused()));
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

  // Version installée : les installateurs devenus inutiles sont retirés du dossier temporaire, puis — hors
  // auto-test, et si le réglage le demande — une version plus récente est recherchée, une fois l'interface affichée.
  if (updateEngine) {
    try {
      updateEngine.cleanup({ current: app.getVersion(), newer: (version, current) => compareVersions(version, current) > 0 });
    } catch (error) {
      console.warn(`Mises à jour : ménage impossible (${error?.message ?? error}).`);
    }
    if (!options.selfTest) {
      win.webContents.once('did-finish-load', () => {
        const timer = setTimeout(() => services.updates.checkAtLaunch(), UPDATE_CHECK_DELAY_MS);
        win.once('closed', () => clearTimeout(timer));
      });
    }
  }

  if (options.selfTest) {
    // Sans déplacement sans remplacement, l'auto-test n'a pas lieu : l'échec et sa cause sont consignés.
    if (moveNoReplaceFailure) return abortSelfTest(moveNoReplaceFailure);
    // Chargé à la demande : l'auto-test ne sert qu'à la compilation automatique.
    const { runSelfTest } = require('./selftest');
    const exitCode = await runSelfTest(win, {
      outDir: selfTestOutputDir(),
      scenario: options.selfTestScenario || undefined,
      describeServices: () => services.describe(),
      // La fonction même que les opérations emploient : l'auto-test l'éprouve sur le disque.
      moveNoReplace,
      // Dossier où le moteur télécharge une mise à jour : l'auto-test y constate ce qui a été reçu.
      updateDir: updateEngine ? updateEngine.dir : null,
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

// Fermeture normale : un réglage modifié à l'instant est enregistré avant l'arrêt ; un téléchargement en
// cours est interrompu.
app.on('will-quit', () => {
  if (!services) return;
  services.updates.dispose();
  services.flushSync();
});

// Aucune fenêtre secondaire pour tout contenu créé par la suite.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
