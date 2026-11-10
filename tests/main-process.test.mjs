/**
 * Processus principal de l'application de bureau (src/main/main.js) et script
 * de préchargement, exécutés avec un faux module « electron »
 * (tests/fixtures/fake-electron.cjs) : fenêtre, sécurité, raccourcis, canaux
 * de communication, instance unique, auto-test, services et réglages.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { fromRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createFakeElectron, cancellable } = require('./fixtures/fake-electron.cjs');
const { settingsDir, settingsFile } = require('../src/services/platform.js');

const ELECTRON = require.resolve('electron');
const MAIN = fromRoot('src', 'main', 'main.js');
const PRELOAD = fromRoot('src', 'main', 'preload.js');
const SELFTEST = fromRoot('src', 'main', 'selftest.js');
const STATUS = fromRoot('src', 'main', 'status.js');
const ARGS = fromRoot('src', 'main', 'args.js');

/** Laisse s'exécuter les suites de promesses en attente. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

/** Place un faux module dans le cache de `require`. */
function stubModule(file, exports) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
  cleanups.push(() => delete require.cache[file]);
}

/**
 * Charge le processus principal avec un faux Electron.
 * @param {object} [options]
 * @param {string[]} [options.argv]        arguments de la ligne de commande
 * @param {boolean} [options.ready]        émettre l'événement « prêt » d'Electron
 * @param {Function} [options.runSelfTest] remplace l'auto-test réel
 * @param {Function} [options.reportStatus] remplace le compte rendu de démarrage réel
 * @param {object} [options.env]           variables d'environnement à définir
 * @param {string} [options.tempDir]       dossier temporaire d'un lancement précédent, pour
 *                                         simuler un redémarrage sur la même machine
 */
async function launch({ argv = [], ready = true, runSelfTest, reportStatus, env = {}, tempDir = null, ...electronOptions } = {}) {
  tempDir ??= mkdtempSync(path.join(tmpdir(), 'evolve-main-'));
  const fake = createFakeElectron({ tempDir, ...electronOptions });
  fake.tempDir = tempDir;
  /** Fichier des réglages par défaut : dans le faux profil de l'utilisateur. */
  fake.settingsFile = settingsFile(settingsDir({ appData: fake.app.getPath('appData') }));

  stubModule(ELECTRON, fake.electron);
  if (runSelfTest) stubModule(SELFTEST, { runSelfTest });
  // Par défaut, tout appel au compte rendu de démarrage est une erreur du test.
  stubModule(STATUS, {
    reportStatus:
      reportStatus ??
      (() => {
        throw new Error('compte rendu de démarrage inattendu');
      }),
  });
  for (const file of [MAIN, PRELOAD, ARGS]) delete require.cache[file];

  const savedArgv = process.argv;
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const listenersBefore = {
    uncaughtException: process.listeners('uncaughtException'),
    unhandledRejection: process.listeners('unhandledRejection'),
  };
  Object.assign(process.env, env);
  process.argv = ['Evolve.exe', ...argv];

  cleanups.push(() => {
    process.argv = savedArgv;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Retire les gestionnaires d'erreurs installés par l'application elle-même.
    for (const [event, before] of Object.entries(listenersBefore)) {
      for (const listener of process.listeners(event)) {
        if (!before.includes(listener)) process.removeListener(event, listener);
      }
    }
    for (const win of fake.state.windows) win.close();
    // Fermeture de l'application : plus aucun enregistrement de réglages en attente.
    fake.app.emit('will-quit');
    for (const file of [MAIN, PRELOAD, ARGS]) delete require.cache[file];
    rmSync(tempDir, { recursive: true, force: true });
  });

  require(MAIN);
  if (ready) {
    fake.ready();
    await settle();
  }
  fake.window = fake.state.windows[0] ?? null;
  return fake;
}

/** Charge le script de préchargement pour la page de `webContents` et renvoie l'objet exposé. */
function loadPreload(fake, webContents) {
  fake.electron.ipcRenderer = fake.rendererFor(webContents);
  delete require.cache[PRELOAD];
  require(PRELOAD);
  return fake.state.exposed.evolve;
}

// ---------------------------------------------------------------------------------
// Fenêtre
// ---------------------------------------------------------------------------------

test('lancement normal : une seule fenêtre, en plein écran, sur la page locale', async () => {
  const { state, window } = await launch();
  assert.equal(state.windows.length, 1);
  assert.equal(window.options.fullscreen, true);
  assert.equal(window.options.show, false, "la fenêtre n'apparaît qu'une fois son contenu prêt");
  assert.equal(window.options.backgroundColor, '#05020c');
  assert.equal(window.options.title, 'Evolve');
  assert.equal(window.loadedFile, fromRoot('src', 'renderer', 'index.html'));
  assert.ok(existsSync(window.loadedFile));
  assert.deepEqual(state.exitCodes, []);
  assert.deepEqual(state.errorBoxes, []);
});

test('la page est isolée : ni Node.js, ni navigation, ni fenêtre secondaire, ni autorisation', async () => {
  const { state, window } = await launch();
  const prefs = window.options.webPreferences;
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.preload, PRELOAD);
  assert.equal(prefs.backgroundThrottling, true);

  const { webContents } = window;
  assert.deepEqual(webContents.openHandler(), { action: 'deny' });
  for (const name of ['will-navigate', 'will-attach-webview']) {
    const event = cancellable();
    webContents.emit(name, event);
    assert.equal(event.defaultPrevented, true, name);
  }
  assert.deepEqual(webContents.zoomLimits, [1, 1]);

  assert.equal(state.menu, null, 'aucune barre de menus native');
  let granted;
  state.permissionHandler(webContents, 'media', (value) => {
    granted = value;
  });
  assert.equal(granted, false, 'toute demande d’autorisation est refusée');
});

test('aucune connexion réseau : seules les ressources locales sont chargées', async () => {
  const { state } = await launch();
  assert.equal(typeof state.requestFilter, 'function');
  assert.equal(state.requestFilterUrls, null, 'le filtre examine toutes les requêtes');

  const decision = (url) => {
    let answer;
    state.requestFilter({ url }, (value) => {
      answer = value;
    });
    return answer;
  };
  for (const url of [
    'http://example.com/',
    'https://example.com/police.woff2',
    'HTTPS://EXAMPLE.COM/',
    'ws://example.com/flux',
    'wss://example.com/flux',
    'ftp://example.com/fichier',
  ]) {
    assert.deepEqual(decision(url), { cancel: true }, url);
  }
  for (const url of [
    'file:///C:/Users/moi/AppData/Local/Temp/Evolve-portable/resources/app.asar/src/renderer/index.html',
    'file:///C:/chemin/assets/wallpapers/panorama-cosmique-violet-sur-lac-miroir.png',
    'devtools://devtools/bundled/devtools_app.html',
    'data:image/png;base64,AAAA',
    'blob:file:///5a1c3d1e',
  ]) {
    assert.deepEqual(decision(url), { cancel: false }, url);
  }
});

test('les données de travail vont dans le dossier temporaire ; sans réglage modifié, rien dans le profil', async () => {
  const { app, state, tempDir, window } = await launch();
  assert.equal(state.paths.userData, path.join(tempDir, 'Evolve'));
  assert.ok(existsSync(state.paths.userData));
  assert.deepEqual(Object.keys(state.paths), ['userData']);
  assert.deepEqual(state.switches, [], 'aucune option particulière du moteur hors auto-test');

  // Un lancement puis une fermeture sans rien changer : le profil reste intact.
  window.close();
  app.emit('window-all-closed');
  app.emit('will-quit');
  assert.deepEqual(readdirSync(tempDir), ['Evolve'], 'seul le dossier de travail temporaire existe');
});

test('--windowed : fenêtre 16:9 adaptée à l’écran', async () => {
  const cases = [
    [{ width: 1920, height: 1040 }, { width: 1600, height: 900 }],
    [{ width: 1366, height: 728 }, { width: 1229, height: 655 }],
    [{ width: 1024, height: 728 }, { width: 960, height: 655 }],
    [{ width: 800, height: 560 }, { width: 960, height: 600 }],
    [{ width: 3840, height: 2100 }, { width: 1600, height: 900 }],
  ];
  for (const [workArea, expected] of cases) {
    const { window } = await launch({ argv: ['--windowed'], workArea });
    assert.equal(window.options.fullscreen, false);
    assert.equal(window.options.useContentSize, true);
    assert.deepEqual({ width: window.options.width, height: window.options.height }, expected, JSON.stringify(workArea));
    assert.ok(window.options.minWidth <= window.options.width && window.options.minHeight <= window.options.height);
  }
});

test('la fenêtre apparaît au premier rendu, sinon à la fin du chargement, sinon après un délai', async (t) => {
  // Horloge simulée pour tout le test : aucun délai réel n'est attendu.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const first = await launch();
  assert.equal(first.window.visible, false);
  first.window.emit('ready-to-show');
  assert.equal(first.window.visible, true);
  first.window.webContents.emit('did-finish-load');
  assert.equal(first.window.showCalls, 1, 'une seule apparition');

  const second = await launch();
  second.window.webContents.emit('did-finish-load');
  assert.equal(second.window.visible, true, 'le chargement terminé suffit');

  const third = await launch();
  assert.equal(third.window.visible, false);
  t.mock.timers.tick(4999);
  assert.equal(third.window.visible, false);
  t.mock.timers.tick(1);
  assert.equal(third.window.visible, true, 'jamais d’application lancée mais invisible');
  assert.equal(first.window.showCalls + second.window.showCalls, 2, 'le délai ne réaffiche pas une fenêtre déjà visible');
});

test('échec du chargement de l’interface : message d’erreur puis arrêt', async () => {
  const { state } = await launch({ loadError: new Error('ERR_FILE_NOT_FOUND (-6)') });
  assert.equal(state.errorBoxes.length, 1);
  assert.equal(state.errorBoxes[0][0], 'Evolve');
  assert.match(state.errorBoxes[0][1], /Impossible de charger l'interface[\s\S]*ERR_FILE_NOT_FOUND/);
  assert.deepEqual(state.exitCodes, [1]);
});

test('arrêt inattendu de l’affichage : un rechargement, puis message d’erreur et arrêt', async () => {
  const { state, window } = await launch();
  const { webContents } = window;
  webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
  assert.equal(webContents.reloads, 0);
  webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(webContents.reloads, 1);
  assert.deepEqual(state.exitCodes, []);
  webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(webContents.reloads, 1);
  assert.equal(state.errorBoxes.length, 1);
  assert.deepEqual(state.exitCodes, [1]);
});

// ---------------------------------------------------------------------------------
// Clavier
// ---------------------------------------------------------------------------------

test('F11 bascule le plein écran et prévient l’interface', async () => {
  const { window } = await launch();
  const press = (key, type = 'keyDown') => {
    const event = cancellable();
    window.webContents.emit('before-input-event', event, { type, key });
    return event;
  };

  assert.equal(press('F11', 'keyUp').defaultPrevented, false);
  assert.equal(window.fullScreen, true, 'le relâchement de la touche est ignoré');

  assert.equal(press('F11').defaultPrevented, true);
  assert.equal(window.fullScreen, false);
  assert.equal(press('F11').defaultPrevented, true);
  assert.equal(window.fullScreen, true);
  assert.deepEqual(window.webContents.sent, [
    ['evolve:fullscreen-changed', false],
    ['evolve:fullscreen-changed', true],
  ]);

  assert.equal(press('a').defaultPrevented, false, 'les autres touches vont à l’interface');
});

test('F12 : outils de développement seulement sur demande (--devtools) ou en développement', async () => {
  const press = (window) => {
    const event = cancellable();
    window.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'F12' });
    return event.defaultPrevented;
  };

  const packaged = await launch({ packaged: true });
  assert.equal(packaged.window.options.webPreferences.devTools, false);
  assert.equal(press(packaged.window), false);
  assert.equal(packaged.window.webContents.devToolsToggles, 0);

  const withFlag = await launch({ packaged: true, argv: ['--devtools'] });
  assert.equal(withFlag.window.options.webPreferences.devTools, true);
  assert.equal(press(withFlag.window), true);
  assert.equal(withFlag.window.webContents.devToolsToggles, 1);

  const development = await launch({ packaged: false });
  assert.equal(development.window.options.webPreferences.devTools, true);
  assert.equal(press(development.window), true);
});

// ---------------------------------------------------------------------------------
// Passerelle entre l'interface et l'application
// ---------------------------------------------------------------------------------

test('passerelle : seules six entrées sont exposées à la page', async () => {
  const fake = await launch();
  const api = loadPreload(fake, fake.window.webContents);
  assert.deepEqual(Object.keys(fake.state.exposed), ['evolve']);
  assert.deepEqual(Object.keys(api).sort(), ['isDesktopApp', 'isFullscreen', 'onFullscreenChange', 'quit', 'services', 'toggleFullscreen']);
  assert.equal(api.isDesktopApp, true);
  // Les services ne sont joignables que par leur nom : appeler une méthode, écouter un événement.
  assert.deepEqual(Object.keys(api.services).sort(), ['call', 'on']);
});

test('passerelle : plein écran et fermeture', async () => {
  const fake = await launch();
  const { window, state } = fake;
  const api = loadPreload(fake, window.webContents);

  assert.equal(await api.isFullscreen(), true);
  const seen = [];
  const unsubscribe = api.onFullscreenChange((value) => seen.push(value));

  assert.equal(await api.toggleFullscreen(), false);
  assert.equal(window.fullScreen, false);
  assert.equal(await api.isFullscreen(), false);
  assert.equal(await api.toggleFullscreen(), true);
  assert.deepEqual(seen, [false, true]);

  unsubscribe();
  await api.toggleFullscreen();
  assert.deepEqual(seen, [false, true], 'plus aucune notification après désabonnement');
  assert.equal(typeof api.onFullscreenChange('pas une fonction'), 'function');

  assert.equal(state.quitCalls, 0);
  api.quit();
  assert.equal(state.quitCalls, 1);
});

test('passerelle : les messages d’une autre page sont ignorés', async () => {
  const fake = await launch();
  const { window, state } = fake;
  const stranger = fake.rendererFor({ rendererListeners: new Map() });

  assert.equal(await stranger.invoke('evolve:toggle-fullscreen'), false);
  assert.equal(window.fullScreen, true, 'le plein écran est inchangé');
  assert.equal(await stranger.invoke('evolve:is-fullscreen'), false);
  stranger.send('evolve:quit');
  assert.equal(state.quitCalls, 0);

  // Les services aussi : ni lecture, ni modification des réglages.
  const refused = { ok: false, code: 'forbidden', message: 'Appel refusé.' };
  assert.deepEqual(await stranger.invoke('evolve:service-call', 'settings', 'getAll', []), refused);
  assert.deepEqual(await stranger.invoke('evolve:service-call', 'settings', 'set', ['quick.volume', 5]), refused);
  const api = loadPreload(fake, window.webContents);
  assert.deepEqual(await api.services.call('settings', 'get', 'quick.volume'), { ok: true, value: 64 });

  assert.deepEqual([...state.ipcListeners.keys()], ['evolve:quit']);
  assert.deepEqual([...state.ipcHandlers.keys()].sort(), ['evolve:is-fullscreen', 'evolve:service-call', 'evolve:toggle-fullscreen']);
});

// ---------------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------------

test('fermer la fenêtre quitte l’application', async () => {
  const { app, state, window } = await launch();
  window.close();
  app.emit('window-all-closed');
  assert.equal(state.quitCalls, 1);
});

test('second lancement : la fenêtre existante est réactivée', async () => {
  const { app, window } = await launch();
  window.minimized = true;
  app.emit('second-instance');
  assert.equal(window.minimized, false);
  assert.equal(window.visible, true);
  assert.equal(window.focusCalls, 1);
});

test('instance déjà ouverte : la nouvelle s’arrête sans ouvrir de fenêtre', async () => {
  const { state } = await launch({ lock: false });
  assert.deepEqual(state.exitCodes, [0]);
  assert.equal(state.windows.length, 0);
});

test('toute fenêtre secondaire est refusée, quel que soit le contenu', async () => {
  const { app } = await launch();
  let handler;
  app.emit('web-contents-created', {}, { setWindowOpenHandler: (value) => (handler = value) });
  assert.deepEqual(handler(), { action: 'deny' });
});

// ---------------------------------------------------------------------------------
// Auto-test (--self-test)
// ---------------------------------------------------------------------------------

test('auto-test : fenêtre non plein écran, rendu jamais suspendu, données séparées', async () => {
  const calls = [];
  const { state, window, tempDir } = await launch({
    argv: ['--self-test=resultats'],
    env: { PORTABLE_EXECUTABLE_DIR: path.join(tmpdir(), 'dossier-du-exe') },
    runSelfTest: async (win, options) => {
      calls.push([win, options]);
      return 0;
    },
  });

  assert.equal(window.options.fullscreen, false);
  assert.equal(window.options.webPreferences.backgroundThrottling, false);
  assert.deepEqual(state.switches, [
    'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows',
    'disable-features=CalculateNativeWinOcclusion',
  ]);
  assert.equal(state.paths.userData, path.join(tempDir, 'Evolve-autotest'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], window);
  // Chemin relatif : résolu depuis le dossier du fichier .exe portable.
  const { describeServices, ...options } = calls[0][1];
  assert.deepEqual(options, { outDir: path.join(tmpdir(), 'dossier-du-exe', 'resultats'), scenario: undefined });
  // Les réglages de l'utilisateur ne sont ni lus ni modifiés par un auto-test : tout reste en mémoire.
  const { settings } = describeServices();
  assert.equal(settings.storage, 'memory');
  assert.equal(settings.file, null);
  assert.deepEqual(state.exitCodes, [0]);
  assert.deepEqual(state.errorBoxes, [], 'jamais de boîte de dialogue pendant un auto-test');
});

test('auto-test : le code de sortie reflète le résultat', async () => {
  for (const [returned, expected] of [[0, 0], [1, 1], [undefined, 1], [7, 1]]) {
    const { state } = await launch({
      argv: [`--self-test=${path.join(tmpdir(), 'evolve-inutilise')}`],
      runSelfTest: async () => returned,
    });
    assert.deepEqual(state.exitCodes, [expected], `valeur renvoyée : ${returned}`);
  }
});

test('auto-test : dossier de résultats absolu ou par défaut', async () => {
  const absolute = path.join(tmpdir(), 'evolve-absolu');
  let received;
  const run = async (_win, options) => {
    received = options.outDir;
    return 0;
  };

  await launch({ argv: [`--self-test=${absolute}`], env: { PORTABLE_EXECUTABLE_DIR: path.join(tmpdir(), 'ailleurs') }, runSelfTest: run });
  assert.equal(received, absolute);

  await launch({ argv: ['--self-test'], env: { PORTABLE_EXECUTABLE_DIR: '' }, runSelfTest: run });
  assert.equal(received, path.resolve(process.cwd(), 'self-test-output'));
});

test('auto-test : une erreur fatale est consignée et donne un échec, sans boîte de dialogue', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'evolve-fatal-'));
  cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

  const { state } = await launch({
    argv: [`--self-test=${outDir}`],
    runSelfTest: async () => {
      throw new Error('panne simulée');
    },
  });
  assert.deepEqual(state.exitCodes, [1]);
  assert.deepEqual(state.errorBoxes, []);
  assert.match(readFileSync(path.join(outDir, 'fatal-error.log'), 'utf8'), /panne simulée/);
});

test('auto-test : une instance déjà ouverte est un échec, jamais une réussite', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'evolve-lock-'));
  cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

  const { state } = await launch({ argv: [`--self-test=${outDir}`], lock: false, runSelfTest: async () => 0 });
  assert.deepEqual(state.exitCodes, [1]);
  assert.equal(state.windows.length, 0);
  assert.match(readFileSync(path.join(outDir, 'fatal-error.log'), 'utf8'), /déjà en cours/);
});

test('auto-test : fermer la fenêtre ne décide pas du code de sortie', async () => {
  let finish;
  const { app, state } = await launch({
    argv: [`--self-test=${path.join(tmpdir(), 'evolve-inutilise')}`],
    runSelfTest: () => new Promise((resolve) => (finish = resolve)),
  });
  app.emit('window-all-closed');
  assert.equal(state.quitCalls, 0);
  assert.deepEqual(state.exitCodes, []);
  finish(0);
  await settle();
  assert.deepEqual(state.exitCodes, [0]);
});

// ---------------------------------------------------------------------------------
// Compte rendu de démarrage (--status-file)
// ---------------------------------------------------------------------------------

test('--status-file : compte rendu demandé en lancement normal, sans changer l’affichage', async () => {
  const absolute = path.join(tmpdir(), 'evolve-etat', 'etat.json');
  const calls = [];
  const fake = await launch({
    argv: [`--status-file=${absolute}`],
    env: { PORTABLE_EXECUTABLE_DIR: path.join(tmpdir(), 'ailleurs') },
    reportStatus: async (win, options) => {
      calls.push({ win, options });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].win, fake.window);
  assert.equal(calls[0].options.file, absolute);
  assert.equal(calls[0].options.screen, fake.electron.screen);
  assert.equal(calls[0].options.userData, path.join(fake.tempDir, 'Evolve'));
  // Le compte rendu cite l'emplacement des réglages : le dossier de l'utilisateur.
  const { settings } = calls[0].options.describeServices();
  assert.equal(settings.file, fake.settingsFile);
  assert.equal(settings.storage, 'file');
  assert.equal(settings.exists, false);
  // Le lancement reste strictement celui d'un double-clic.
  assert.equal(fake.window.options.fullscreen, true);
  assert.equal(fake.window.options.webPreferences.backgroundThrottling, true);
  assert.equal(fake.state.paths.userData, path.join(fake.tempDir, 'Evolve'));
  assert.deepEqual(fake.state.switches, []);
  assert.deepEqual(fake.state.exitCodes, []);
});

test('--status-file : chemin relatif résolu depuis le dossier du fichier .exe', async () => {
  let received;
  const reportStatus = async (_win, options) => {
    received = options.file;
  };
  const exeDir = path.join(tmpdir(), 'dossier-du-exe');

  await launch({ argv: ['--status-file=etat.json'], env: { PORTABLE_EXECUTABLE_DIR: exeDir }, reportStatus });
  assert.equal(received, path.join(exeDir, 'etat.json'));

  await launch({ argv: ['--status-file=etat.json'], env: { PORTABLE_EXECUTABLE_DIR: '' }, reportStatus });
  assert.equal(received, path.resolve(process.cwd(), 'etat.json'));
});

test('--status-file : un compte rendu impossible ne gêne pas l’application', async () => {
  const { state } = await launch({
    argv: ['--status-file=etat.json'],
    reportStatus: async () => {
      throw new Error('disque plein');
    },
  });
  await settle();
  assert.deepEqual(state.exitCodes, []);
  assert.deepEqual(state.errorBoxes, []);
  assert.equal(state.windows.length, 1);
});

test('sans --status-file, ou pendant l’auto-test, aucun compte rendu de démarrage', async () => {
  // Le faux module lève une erreur au moindre appel (voir launch()).
  const normal = await launch();
  assert.deepEqual(normal.state.exitCodes, []);
  assert.deepEqual(normal.state.errorBoxes, []);

  const selfTest = await launch({ argv: ['--self-test', '--status-file=etat.json'], runSelfTest: async () => 0 });
  assert.deepEqual(selfTest.state.exitCodes, [0]);
});

// ---------------------------------------------------------------------------------
// Services et réglages
// ---------------------------------------------------------------------------------

/** Contenu du fichier des réglages, ou `null` s'il n'existe pas. */
const readSettings = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

test('réglages : un changement fait dans la fenêtre est enregistré dans le profil et retrouvé au lancement suivant', async () => {
  const first = await launch();
  const api = loadPreload(first, first.window.webContents);
  assert.equal(readSettings(first.settingsFile), null, 'rien avant le premier changement');

  assert.deepEqual(await api.services.call('settings', 'set', 'quick.nightLight', true), { ok: true, value: true });
  assert.deepEqual(await api.services.call('settings', 'set', 'quick.brightness', 5), { ok: true, value: 20 }, 'valeur ramenée dans les bornes');
  // Fermeture normale de l'application.
  first.window.close();
  first.app.emit('window-all-closed');
  first.app.emit('will-quit');

  const saved = readSettings(first.settingsFile);
  assert.deepEqual(saved.values, { 'quick.brightness': 20, 'quick.nightLight': true });
  assert.equal(saved.schema, 1);
  assert.equal(saved.app, '9.8.7', "version de l'application notée dans le fichier");
  assert.deepEqual(readdirSync(path.dirname(first.settingsFile)), ['settings.json'], 'un seul fichier dans le dossier des réglages');

  // Nouveau lancement — nouveau processus principal — sur la même machine.
  const second = await launch({ tempDir: first.tempDir });
  const again = loadPreload(second, second.window.webContents);
  const all = await again.services.call('settings', 'getAll');
  assert.equal(all.ok, true);
  assert.equal(all.value['quick.nightLight'], true);
  assert.equal(all.value['quick.brightness'], 20);
  assert.equal(all.value['quick.volume'], 64, 'les autres réglages gardent leur valeur par défaut');
  assert.deepEqual(await again.services.call('settings', 'state'), {
    ok: true,
    value: { storage: 'file', durable: true, problem: null, recovered: null },
  });
});

test('réglages : enregistrés aussi à la fin de la session Windows et avant un arrêt immédiat', async () => {
  // Arrêt de l'ordinateur ou fermeture de session : seule la fenêtre en est prévenue.
  const session = await launch();
  await loadPreload(session, session.window.webContents).services.call('settings', 'set', 'quick.muted', true);
  session.window.emit('session-end');
  assert.deepEqual(readSettings(session.settingsFile).values, { 'quick.muted': true });

  // Erreur irrécupérable : message puis arrêt immédiat, sans événement de fermeture.
  const crash = await launch();
  await loadPreload(crash, crash.window.webContents).services.call('settings', 'set', 'quick.volume', 10);
  crash.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  crash.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(crash.state.exitCodes, [1]);
  assert.deepEqual(readSettings(crash.settingsFile).values, { 'quick.volume': 10 });
});

test('réglages : --settings-dir choisit le dossier ; un chemin relatif part du dossier du fichier .exe', async () => {
  const exeDir = mkdtempSync(path.join(tmpdir(), 'evolve-dossier-du-exe-'));
  cleanups.push(() => rmSync(exeDir, { recursive: true, force: true }));

  const fake = await launch({ argv: ['--settings-dir=reglages'], env: { PORTABLE_EXECUTABLE_DIR: exeDir } });
  await loadPreload(fake, fake.window.webContents).services.call('settings', 'set', 'desktop.widgetsVisible', false);
  fake.app.emit('will-quit');

  assert.deepEqual(readSettings(path.join(exeDir, 'reglages', 'settings.json')).values, { 'desktop.widgetsVisible': false });
  assert.equal(existsSync(path.join(fake.tempDir, 'profil')), false, 'rien dans le profil de l’utilisateur');
});

test('réglages : un auto-test ne lit ni ne modifie ceux de l’utilisateur, sauf dossier demandé', async () => {
  // L'utilisateur a déjà des réglages.
  const user = await launch();
  await loadPreload(user, user.window.webContents).services.call('settings', 'set', 'quick.volume', 10);
  user.app.emit('will-quit');
  const before = readFileSync(user.settingsFile, 'utf8');

  // Auto-test sur la même machine : valeurs par défaut, tout reste en mémoire.
  let finish;
  const selfTest = await launch({
    tempDir: user.tempDir,
    argv: [`--self-test=${path.join(tmpdir(), 'evolve-inutilise')}`],
    runSelfTest: () => new Promise((resolve) => (finish = resolve)),
  });
  const api = loadPreload(selfTest, selfTest.window.webContents);
  assert.deepEqual(await api.services.call('settings', 'get', 'quick.volume'), { ok: true, value: 64 });
  assert.deepEqual(await api.services.call('settings', 'set', 'quick.volume', 99), { ok: true, value: 99 });
  assert.equal((await api.services.call('settings', 'state')).value.storage, 'memory');
  finish(0);
  await settle();
  assert.deepEqual(selfTest.state.exitCodes, [0]);
  assert.equal(readFileSync(user.settingsFile, 'utf8'), before, 'réglages de l’utilisateur intacts');

  // Avec --settings-dir, l'auto-test enregistre dans le dossier demandé — avant
  // de s'arrêter, bien que l'arrêt de l'auto-test n'émette aucun événement.
  const dir = mkdtempSync(path.join(tmpdir(), 'evolve-reglages-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let options;
  const scenario = await launch({
    argv: ['--self-test', `--settings-dir=${dir}`, '--self-test-scenario=settings-write'],
    runSelfTest: (_win, received) => {
      options = received;
      return new Promise((resolve) => (finish = resolve));
    },
  });
  assert.equal(options.scenario, 'settings-write');
  assert.equal(options.describeServices().settings.file, path.join(dir, 'settings.json'));
  await loadPreload(scenario, scenario.window.webContents).services.call('settings', 'set', 'quick.nightLight', true);
  assert.equal(readSettings(path.join(dir, 'settings.json')), null, 'pas encore enregistré');
  finish(0);
  await settle();
  assert.deepEqual(scenario.state.exitCodes, [0]);
  assert.deepEqual(readSettings(path.join(dir, 'settings.json')).values, { 'quick.nightLight': true });
});

test('réglages : seule l’instance qui garde la main touche au fichier', async () => {
  const first = await launch();
  const dir = path.dirname(first.settingsFile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(first.settingsFile, '{ "values": ');

  // Second lancement alors qu'Evolve est déjà ouvert : il s'arrête sans rien lire ni déplacer.
  const second = await launch({ tempDir: first.tempDir, lock: false });
  assert.deepEqual(second.state.exitCodes, [0]);
  assert.deepEqual(readdirSync(dir), ['settings.json']);

  // Lancement suivant : le contenu inutilisable est mis de côté, jamais perdu,
  // et la page peut savoir que les réglages ont été réinitialisés.
  const third = await launch({ tempDir: first.tempDir });
  const api = loadPreload(third, third.window.webContents);
  assert.deepEqual(readdirSync(dir), ['settings.corrupt.json']);
  assert.equal(readFileSync(path.join(dir, 'settings.corrupt.json'), 'utf8'), '{ "values": ');
  assert.deepEqual((await api.services.call('settings', 'state')).value, { storage: 'file', durable: true, problem: null, recovered: 'corrupt' });
  assert.equal((await api.services.call('settings', 'get', 'quick.volume')).value, 64);
});

test('services : la page ne peut appeler que les méthodes publiques, avec de simples données', async () => {
  const fake = await launch();
  const api = loadPreload(fake, fake.window.webContents);
  const code = async (...args) => (await api.services.call(...args)).code;

  assert.equal(await code('settings', 'flushSync'), 'unknown-method', 'méthode interne');
  assert.equal(await code('settings', 'status'), 'unknown-method', 'méthode interne');
  assert.equal(await code('settings', 'constructor'), 'unknown-method');
  assert.equal(await code('settings', '__proto__'), 'unknown-method');
  assert.equal(await code('fichiers', 'lire', 'C:\\Windows'), 'unknown-service');
  assert.equal(await code('settings', 'set', 'quick.inconnu', true), 'unknown-key');
  assert.equal(await code('settings', 'set', 'quick.volume', 'fort'), 'invalid-value');
  assert.equal(await code('settings', 'set', 'quick.volume', { valeur: 10 }), 'invalid-value');
  assert.equal(await code('settings', 'set', ...new Array(9).fill(1)), 'bad-arguments');
  assert.equal(await code('settings', 'set', 'quick.volume', [[[[[[[[10]]]]]]]]), 'bad-arguments');

  // Une demande impossible à transmettre (ici, une fonction) : réponse d'échec, jamais d'exception.
  const untransmitted = await api.services.call('settings', 'set', 'quick.volume', () => 10);
  assert.deepEqual(untransmitted, { ok: false, code: 'failed', message: "La demande n'a pas pu être transmise." });
  assert.equal((await api.services.call({ toString: () => assert.fail('nom piégé') }, 'getAll')).code, 'failed');

  // Rien de tout cela n'a modifié ni enregistré quoi que ce soit.
  fake.app.emit('will-quit');
  assert.equal(readSettings(fake.settingsFile), null);
});

test('services : la fenêtre est prévenue des événements, sauf de ses propres changements', async () => {
  const fake = await launch();
  const { window } = fake;
  const api = loadPreload(fake, window.webContents);
  const states = [];
  const changes = [];
  const unsubscribe = api.services.on('settings', 'state', (state) => states.push(state));
  api.services.on('settings', 'changed', (change) => changes.push(change));
  assert.equal(typeof api.services.on('settings', 'state', 'pas une fonction'), 'function');

  // Le dossier des réglages ne peut pas être créé : un fichier porte déjà son nom.
  const dir = path.dirname(fake.settingsFile);
  mkdirSync(path.dirname(dir), { recursive: true });
  writeFileSync(dir, 'occupé');

  await api.services.call('settings', 'set', 'quick.volume', 10);
  assert.deepEqual(changes, [], 'la fenêtre connaît déjà le changement qu’elle a demandé');
  assert.deepEqual(states, []);

  // L'enregistrement échoue : la fenêtre en est prévenue (une seule fois).
  window.emit('session-end');
  window.emit('session-end');
  const failing = { storage: 'file', durable: false, problem: 'unwritable', recovered: null };
  assert.deepEqual(states, [failing]);
  assert.deepEqual(
    window.webContents.sent.filter(([channel]) => channel === 'evolve:service-event'),
    [['evolve:service-event', { service: 'settings', event: 'state', payload: failing }]],
  );
  assert.equal((await api.services.call('settings', 'get', 'quick.volume')).value, 10, 'la valeur reste en mémoire');

  // Le dossier redevient accessible : l'enregistrement reprend, la fenêtre le sait.
  rmSync(dir);
  window.emit('session-end');
  assert.deepEqual(states.at(-1), { storage: 'file', durable: true, problem: null, recovered: null });
  assert.deepEqual(readSettings(fake.settingsFile).values, { 'quick.volume': 10 });

  // Après désabonnement, l'abonné n'est plus appelé…
  unsubscribe();
  const count = states.length;
  const sent = () => window.webContents.sent.filter(([channel]) => channel === 'evolve:service-event').length;
  rmSync(dir, { recursive: true });
  writeFileSync(dir, 'occupé');
  await api.services.call('settings', 'set', 'quick.volume', 11);
  window.emit('session-end');
  assert.equal(sent(), 3, 'la fenêtre reçoit toujours l’événement');
  assert.equal(states.length, count);

  // … et après la fermeture de la fenêtre, plus rien ne lui est envoyé.
  window.close();
  rmSync(dir);
  fake.app.emit('will-quit');
  assert.equal(sent(), 3);
  assert.deepEqual(readSettings(fake.settingsFile).values, { 'quick.volume': 11 }, 'enregistré à la fermeture');
});
