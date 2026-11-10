/**
 * Processus principal de l'application de bureau (src/main/main.js) et script
 * de préchargement, exécutés avec un faux module « electron »
 * (tests/fixtures/fake-electron.cjs) : fenêtre, sécurité, raccourcis, canaux
 * de communication, instance unique, auto-test.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { fromRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createFakeElectron, cancellable } = require('./fixtures/fake-electron.cjs');

const ELECTRON = require.resolve('electron');
const MAIN = fromRoot('src', 'main', 'main.js');
const PRELOAD = fromRoot('src', 'main', 'preload.js');
const SELFTEST = fromRoot('src', 'main', 'selftest.js');
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
 * @param {object} [options.env]           variables d'environnement à définir
 */
async function launch({ argv = [], ready = true, runSelfTest, env = {}, ...electronOptions } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'evolve-main-'));
  const fake = createFakeElectron({ tempDir, ...electronOptions });
  fake.tempDir = tempDir;

  stubModule(ELECTRON, fake.electron);
  if (runSelfTest) stubModule(SELFTEST, { runSelfTest });
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

test('les données de travail vont dans le dossier temporaire, jamais dans le profil', async () => {
  const { state, tempDir } = await launch();
  assert.equal(state.paths.userData, path.join(tempDir, 'Evolve'));
  assert.ok(existsSync(state.paths.userData));
  assert.deepEqual(Object.keys(state.paths), ['userData']);
  assert.deepEqual(state.switches, [], 'aucune option particulière du moteur hors auto-test');
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

test('passerelle : seules cinq entrées sont exposées à la page', async () => {
  const fake = await launch();
  const api = loadPreload(fake, fake.window.webContents);
  assert.deepEqual(Object.keys(fake.state.exposed), ['evolve']);
  assert.deepEqual(Object.keys(api).sort(), ['isDesktopApp', 'isFullscreen', 'onFullscreenChange', 'quit', 'toggleFullscreen']);
  assert.equal(api.isDesktopApp, true);
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

  assert.deepEqual([...state.ipcListeners.keys()], ['evolve:quit']);
  assert.deepEqual([...state.ipcHandlers.keys()].sort(), ['evolve:is-fullscreen', 'evolve:toggle-fullscreen']);
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
  assert.deepEqual(calls[0][1], { outDir: path.join(tmpdir(), 'dossier-du-exe', 'resultats') });
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
