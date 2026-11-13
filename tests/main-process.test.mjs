/**
 * Processus principal de l'application de bureau (src/main/main.js) et script
 * de préchargement, exécutés avec un faux module « electron »
 * (tests/fixtures/fake-electron.cjs) : fenêtre, sécurité, raccourcis, canaux
 * de communication, instance unique, auto-test, services, réglages,
 * consultation des dossiers et opérations sur les fichiers.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { fromRoot, loadNativeMove } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createFakeElectron, cancellable } = require('./fixtures/fake-electron.cjs');
const { settingsDir, settingsFile } = require('../src/services/platform.js');

const ELECTRON = require.resolve('electron');
const MAIN = fromRoot('src', 'main', 'main.js');
const PRELOAD = fromRoot('src', 'main', 'preload.js');
const SELFTEST = fromRoot('src', 'main', 'selftest.js');
const STATUS = fromRoot('src', 'main', 'status.js');
const ARGS = fromRoot('src', 'main', 'args.js');
const ATOMIC_MOVE = fromRoot('src', 'main', 'atomic-move.js');

/**
 * Déplacement sans remplacement : le processus principal charge le vrai module natif
 * (native/evolve_fs.c) ; sans lui, les essais d'opérations ne vaudraient rien.
 */
const nativeMove = loadNativeMove();

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
 * @param {Function} [options.loadAtomicMove] remplace le chargement du module natif de déplacement
 *                                         sans remplacement (par défaut : le vrai module)
 * @param {object} [options.env]           variables d'environnement à définir
 * @param {string} [options.tempDir]       dossier temporaire d'un lancement précédent, pour
 *                                         simuler un redémarrage sur la même machine
 */
async function launch({ argv = [], ready = true, runSelfTest, reportStatus, loadAtomicMove, env = {}, tempDir = null, ...electronOptions } = {}) {
  tempDir ??= mkdtempSync(path.join(tmpdir(), 'evolve-main-'));
  const fake = createFakeElectron({ tempDir, ...electronOptions });
  fake.tempDir = tempDir;
  /** Fichier des réglages par défaut : dans le faux profil de l'utilisateur. */
  fake.settingsFile = settingsFile(settingsDir({ appData: fake.app.getPath('appData') }));

  stubModule(ELECTRON, fake.electron);
  if (runSelfTest) stubModule(SELFTEST, { runSelfTest });
  if (loadAtomicMove) stubModule(ATOMIC_MOVE, { loadAtomicMove });
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

test('aucun fichier enregistré : tout téléchargement est annulé avant d’atteindre le disque', async () => {
  const { state, window } = await launch();
  assert.deepEqual([...state.sessionListeners.keys()], ['will-download'], 'seul événement de session écouté');

  // Electron remet l'événement, le téléchargement et la page d'origine : il est annulé sans condition.
  const item = {
    saved: null,
    setSavePath(target) {
      this.saved = target;
    },
    setSaveDialogOptions() {
      throw new Error('aucune boîte d’enregistrement ne doit être préparée');
    },
  };
  for (const source of [window.webContents, new window.webContents.constructor(), undefined]) {
    const event = cancellable();
    state.sessionListeners.get('will-download')(event, item, source);
    assert.equal(event.defaultPrevented, true);
    assert.equal(item.saved, null, 'aucun emplacement d’enregistrement n’est choisi');
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

test('passerelle : seules sept entrées sont exposées à la page', async () => {
  const fake = await launch();
  const api = loadPreload(fake, fake.window.webContents);
  assert.deepEqual(Object.keys(fake.state.exposed), ['evolve']);
  assert.deepEqual(Object.keys(api).sort(), ['files', 'isDesktopApp', 'isFullscreen', 'onFullscreenChange', 'quit', 'services', 'toggleFullscreen']);
  assert.equal(api.isDesktopApp, true);
  // Les services ne sont joignables que par leur nom : appeler une méthode, écouter un événement.
  assert.deepEqual(Object.keys(api.services).sort(), ['call', 'on']);
  // Les opérations sur les fichiers : six demandes, l'arrêt d'une opération et son avancement. Rien d'autre —
  // ni suppression définitive, ni remplacement, ni lecture ou écriture du contenu d'un fichier.
  assert.deepEqual(Object.keys(api.files), ['createFolder', 'rename', 'copy', 'move', 'trash', 'open', 'cancel', 'onProgress']);
  for (const entry of Object.values(api.files)) assert.equal(typeof entry, 'function');
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
  assert.deepEqual([...state.ipcHandlers.keys()].sort(), [
    'evolve:files-cancel',
    'evolve:files-copy',
    'evolve:files-create-folder',
    'evolve:files-move',
    'evolve:files-open',
    'evolve:files-rename',
    'evolve:files-trash',
    'evolve:is-fullscreen',
    'evolve:service-call',
    'evolve:toggle-fullscreen',
  ]);
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
  const { describeServices, moveNoReplace, ...options } = calls[0][1];
  assert.deepEqual(options, { outDir: path.join(tmpdir(), 'dossier-du-exe', 'resultats'), scenario: undefined });
  // L'auto-test reçoit le déplacement sans remplacement que l'application emploie, pour l'éprouver sur le disque :
  // celui du module natif, qui refuse un nom déjà pris.
  const taken = path.join(tempDir, 'pris.txt');
  const moving = path.join(tempDir, 'arrivant.txt');
  writeFileSync(taken, 'en place');
  writeFileSync(moving, 'arrivant');
  await assert.rejects(moveNoReplace(moving, taken), { code: 'EEXIST' });
  assert.deepEqual([readFileSync(taken, 'utf8'), readFileSync(moving, 'utf8')], ['en place', 'arrivant']);
  assert.equal(describeServices()['file-operations'].noReplaceMove, true);
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

// ---------------------------------------------------------------------------------
// Explorateur : consultation des dossiers
// ---------------------------------------------------------------------------------

/** Crée le faux profil de l'utilisateur : dossiers personnels et quelques fichiers. */
function createProfile(tempDir, folders = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) {
  const profile = path.join(tempDir, 'profil');
  mkdirSync(profile, { recursive: true });
  for (const name of folders) mkdirSync(path.join(profile, name));
  if (folders.includes('Documents')) {
    mkdirSync(path.join(profile, 'Documents', 'Projets été'));
    writeFileSync(path.join(profile, 'Documents', 'Notes.txt'), 'bonjour');
  }
  // Chemin réel (noms longs sous Windows) : celui que le service renvoie.
  return realpathSync.native(profile);
}

/** État d'un dossier : chaque élément, sa taille et sa date de modification. */
function snapshotOf(folder) {
  const lines = [];
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, item.name);
      const info = statSync(full);
      lines.push(`${path.relative(folder, full)} ${item.isDirectory() ? 'dossier' : info.size} ${Math.round(info.mtimeMs)}`);
      if (item.isDirectory()) walk(full);
    }
  })(folder);
  return lines;
}

/**
 * Ces tests exécutent le processus principal tel quel : le moteur imité suit
 * donc le comportement du système de la machine qui les exécute (Windows sur
 * la machine de compilation, un autre système en développement), et les
 * attentes en dépendent. Les deux comportements sont aussi éprouvés côte à
 * côte, quel que soit le système, par tests/personal-folders.test.mjs.
 */
const ON_WINDOWS = process.platform === 'win32';

/**
 * Emplacements que l'application demande au moteur pour situer les six dossiers
 * personnels. Sous Windows, le système vérifie lui-même l'existence du dossier
 * Documents ; ailleurs, le moteur le créerait : la question ne lui est pas
 * posée (voir src/main/personal-folders.js).
 */
const ENGINE_REQUESTS = ON_WINDOWS ? ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'] : ['desktop', 'home', 'downloads', 'pictures', 'music', 'videos'];

test('explorateur : les dossiers personnels sont demandés au système à la première consultation ; ensuite, seuls ceux restés introuvables', async () => {
  const fake = await launch();
  const { state, tempDir } = fake;
  const profile = createProfile(tempDir, ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music']);
  state.unknownFolders.push('music');
  const api = loadPreload(fake, fake.window.webContents);

  // Démarrage, réglages : aucun emplacement du compte n'est demandé au moteur.
  await api.services.call('settings', 'getAll');
  assert.deepEqual(state.pathRequests, []);

  const reply = await api.services.call('files', 'places');
  assert.equal(reply.ok, true);
  assert.deepEqual(state.pathRequests, ENGINE_REQUESTS);
  assert.deepEqual(reply.value.places, [
    { id: 'desktop', path: path.join(profile, 'Desktop'), available: true },
    { id: 'documents', path: path.join(profile, 'Documents'), available: true },
    { id: 'downloads', path: path.join(profile, 'Downloads'), available: true },
    { id: 'pictures', path: path.join(profile, 'Pictures'), available: true },
    { id: 'music', path: null, available: false }, // inconnu de Windows
    { id: 'videos', path: null, available: false }, // absent du disque
  ]);
  // Lecteurs locaux recherchés automatiquement : celui du dossier temporaire en fait partie.
  const { root } = path.parse(profile);
  assert.ok(reply.value.drives.some((drive) => drive.path.toLowerCase() === root.toLowerCase()), JSON.stringify(reply.value.drives));

  // Consulter des dossiers ne demande rien de plus au moteur.
  await api.services.call('files', 'list', path.join(profile, 'Documents'));
  await api.services.call('files', 'list', path.join(profile, 'Desktop'));
  assert.equal(state.pathRequests.length, 6);

  // Nouvelle recherche (« Actualiser ») : un emplacement obtenu n'est jamais redemandé ; seuls le sont les
  // dossiers que le système n'a pas su situer. Sous Windows, un dossier absent du disque en fait partie.
  const stillMissing = ON_WINDOWS ? ['music', 'videos'] : ['music'];
  await api.services.call('files', 'places');
  assert.deepEqual(state.pathRequests.slice(6), stillMissing);

  // Le dossier Musique redevient connu du système : il est retrouvé à la recherche suivante, puis n'est plus demandé.
  state.unknownFolders.length = 0;
  const again = await api.services.call('files', 'places');
  assert.deepEqual(again.value.places.find((place) => place.id === 'music'), { id: 'music', path: path.join(profile, 'Music'), available: true });
  const before = state.pathRequests.length;
  await api.services.call('files', 'places');
  assert.deepEqual(state.pathRequests.slice(before), ON_WINDOWS ? ['videos'] : []);
  assert.deepEqual(state.createdByEngine, [], 'le moteur n’a créé aucun dossier');
});

test('explorateur : un dossier Documents absent reste absent après son ouverture — rien n’est créé, nulle part', async () => {
  const fake = await launch();
  const { state, tempDir } = fake;
  const profile = createProfile(tempDir, ['Desktop', 'Downloads', 'Pictures', 'Music', 'Videos']);
  const documents = path.join(profile, 'Documents');
  writeFileSync(path.join(profile, 'Desktop', 'Notes.txt'), 'bonjour');
  // Tout ce que l'application peut atteindre ici : profil, dossier de configuration, dossier temporaire.
  const before = snapshotOf(tempDir);
  const api = loadPreload(fake, fake.window.webContents);

  // Ouverture de l'explorateur : la page demande les emplacements. Documents est signalé absent.
  const places = await api.services.call('files', 'places');
  assert.equal(places.ok, true);
  assert.deepEqual(
    places.value.places.find((place) => place.id === 'documents'),
    { id: 'documents', path: null, available: false },
  );
  assert.deepEqual(
    places.value.places.filter((place) => place.available).map((place) => place.id),
    ['desktop', 'downloads', 'pictures', 'music', 'videos'],
  );
  assert.equal(existsSync(documents), false, 'la recherche des emplacements n’a pas créé le dossier');

  // Ouverture du dossier lui-même, désigné par son emplacement habituel : un refus, sans création.
  for (const target of [documents, `${documents}${path.sep}`, path.join(documents, 'Projets')]) {
    const reply = await api.services.call('files', 'list', target);
    assert.deepEqual([reply.ok, reply.code], [false, 'not-found'], target);
    assert.equal(existsSync(documents), false, target);
  }

  // La session continue : actualisations, consultation d'un autre dossier, fermeture.
  await api.services.call('files', 'places');
  const desktop = await api.services.call('files', 'list', path.join(profile, 'Desktop'));
  assert.deepEqual(desktop.value.entries.map((item) => item.name), ['Notes.txt']);
  await api.services.call('files', 'places');
  fake.app.emit('will-quit');
  await settle();

  assert.equal(existsSync(documents), false, 'le dossier Documents est toujours absent');
  assert.deepEqual(readdirSync(profile).sort(), ['Desktop', 'Downloads', 'Music', 'Pictures', 'Videos']);
  assert.deepEqual(snapshotOf(tempDir), before, 'aucun fichier ni dossier créé, modifié ou supprimé');
  assert.deepEqual(state.createdByEngine, [], 'le moteur n’a rien créé');
  if (ON_WINDOWS) {
    // Windows vérifie lui-même que le dossier existe : la question lui est posée à chaque recherche, sans effet.
    assert.deepEqual(state.pathRequests, [...ENGINE_REQUESTS, 'documents', 'documents']);
  } else {
    // Ailleurs, le moteur créerait le dossier dès qu'on lui en demande l'emplacement : la question n'est jamais posée.
    assert.deepEqual(state.pathRequests, ENGINE_REQUESTS);
    assert.equal(state.pathRequests.includes('documents'), false);
  }
});

test('explorateur : un dossier Documents absent, puis revenu, est retrouvé après une nouvelle recherche — sans avoir été créé par Evolve', async () => {
  const fake = await launch();
  const { state, tempDir } = fake;
  const profile = createProfile(tempDir, ['Desktop', 'Downloads', 'Pictures', 'Music', 'Videos']);
  const documents = path.join(profile, 'Documents');
  const api = loadPreload(fake, fake.window.webContents);
  const place = async () => (await api.services.call('files', 'places')).value.places.find((item) => item.id === 'documents');

  assert.deepEqual(await place(), { id: 'documents', path: null, available: false });
  assert.deepEqual(await place(), { id: 'documents', path: null, available: false });
  assert.equal(existsSync(documents), false);
  assert.deepEqual(state.createdByEngine, []);

  // L'utilisateur remet lui-même son dossier en place (dossier restauré, disque rebranché).
  mkdirSync(documents);
  writeFileSync(path.join(documents, 'Notes.txt'), 'bonjour');
  assert.deepEqual(await place(), { id: 'documents', path: documents, available: true });
  const listing = await api.services.call('files', 'list', documents);
  assert.deepEqual(listing.value.entries.map((item) => item.name), ['Notes.txt']);
  assert.deepEqual(listing.value.root, { id: 'documents', kind: 'place', path: documents });

  // Puis le retire de nouveau : signalé absent, et toujours pas recréé.
  rmSync(documents, { recursive: true });
  assert.deepEqual(await place(), { id: 'documents', path: null, available: false });
  assert.equal((await api.services.call('files', 'list', documents)).code, 'not-found');
  assert.equal(existsSync(documents), false);
  assert.deepEqual(state.createdByEngine, [], 'le moteur n’a jamais rien créé');
  assert.deepEqual(readdirSync(profile).sort(), ['Desktop', 'Downloads', 'Music', 'Pictures', 'Videos']);
});

test('explorateur : aucun dossier personnel sur l’ordinateur — tous signalés absents, aucun créé', async () => {
  const fake = await launch();
  const { state, tempDir } = fake;
  const profile = createProfile(tempDir, []);
  const before = snapshotOf(tempDir);
  const api = loadPreload(fake, fake.window.webContents);

  const places = await api.services.call('files', 'places');
  assert.deepEqual(places.value.places.map((place) => [place.id, place.path, place.available]), [
    ['desktop', null, false],
    ['documents', null, false],
    ['downloads', null, false],
    ['pictures', null, false],
    ['music', null, false],
    ['videos', null, false],
  ]);
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) {
    const reply = await api.services.call('files', 'list', path.join(profile, name));
    assert.deepEqual([reply.ok, reply.code], [false, 'not-found'], name);
  }
  assert.deepEqual(readdirSync(profile), [], 'le profil est resté vide');
  assert.deepEqual(snapshotOf(tempDir), before);
  assert.deepEqual(state.createdByEngine, []);
});

test('explorateur : la page consulte un dossier réel par le service de fichiers, sans rien y changer', async () => {
  const fake = await launch();
  const profile = createProfile(fake.tempDir);
  const documents = path.join(profile, 'Documents');
  const before = snapshotOf(profile);
  const api = loadPreload(fake, fake.window.webContents);

  const listing = await api.services.call('files', 'list', documents);
  assert.equal(listing.ok, true);
  assert.equal(listing.value.path, documents);
  assert.deepEqual(listing.value.root, { id: 'documents', kind: 'place', path: documents });
  assert.deepEqual(
    listing.value.entries.map((item) => [item.name, item.kind, item.size]).sort(),
    [['Notes.txt', 'file', 7], ['Projets été', 'folder', null]],
  );

  // Refus codés, jamais d'exception.
  const code = async (...args) => (await api.services.call('files', ...args)).code;
  assert.equal(await code('list', '..'), 'invalid-path');
  assert.equal(await code('list', `${documents}${path.sep}..${path.sep}..`), 'invalid-path');
  assert.equal(await code('list', path.join(documents, 'Notes.txt')), 'not-a-directory');
  assert.equal(await code('list', path.join(documents, 'Introuvable')), 'not-found');
  assert.equal(await code('list'), 'invalid-path');
  assert.equal(await code('list', { path: documents }), 'invalid-path');
  assert.equal(await code('list', documents, 'en trop', 3, 4, 5, 6, 7, 8, 9), 'bad-arguments');

  // Aucune opération d'écriture, de suppression ni d'ouverture n'existe.
  for (const method of ['write', 'writeFile', 'create', 'mkdir', 'rename', 'move', 'copy', 'delete', 'remove', 'trash', 'open', 'read', 'status']) {
    assert.equal(await code(method, path.join(documents, 'Notes.txt'), 'contenu'), 'unknown-method', method);
  }

  assert.deepEqual(snapshotOf(profile), before, 'le profil est resté tel quel');
  assert.equal(readFileSync(path.join(documents, 'Notes.txt'), 'utf8'), 'bonjour');
  fake.app.emit('will-quit');
  assert.equal(readSettings(fake.settingsFile), null, 'consulter des dossiers n’enregistre aucun réglage');
});

test('explorateur : les événements d’une autre page n’atteignent pas le service de fichiers', async () => {
  const fake = await launch();
  const profile = createProfile(fake.tempDir);
  const stranger = new fake.window.webContents.constructor();
  const api = loadPreload(fake, stranger);
  const reply = await api.services.call('files', 'list', path.join(profile, 'Documents'));
  assert.equal(reply.ok, false);
  assert.deepEqual(fake.state.pathRequests, [], 'aucun dossier n’a été recherché pour elle');
});

// ---------------------------------------------------------------------------------
// Explorateur : opérations sur les fichiers
// ---------------------------------------------------------------------------------

/** Empreinte du contenu d'un fichier. */
const digestOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Lance l'application pour un essai d'opérations sur de vrais fichiers, dans
 * un faux profil placé dans le dossier temporaire.
 *
 * Sous Windows, le dossier temporaire se trouve dans « AppData », que les
 * opérations préservent (dossier du système) : le temps de l'essai, les
 * variables qui le désignent pointent vers le « AppData » du faux profil.
 */
async function launchForOperations(options = {}) {
  const tempDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'evolve-main-')));
  const appData = path.join(tempDir, 'profil', 'AppData');
  const fake = await launch({ ...options, tempDir, env: { APPDATA: path.join(appData, 'Roaming'), LOCALAPPDATA: path.join(appData, 'Local'), ...options.env } });
  const profile = createProfile(tempDir);
  const documents = path.join(profile, 'Documents');
  const api = loadPreload(fake, fake.window.webContents);
  return { fake, state: fake.state, tempDir, profile, documents, api, files: api.files };
}

test('opérations : la page crée, renomme, copie, déplace, ouvre et envoie à la Corbeille de vrais fichiers', async () => {
  const { state, profile, documents, files } = await launchForOperations();
  const notes = path.join(documents, 'Notes.txt');
  const original = digestOf(notes);

  // Nouveau dossier.
  const created = await files.createFolder(documents, 'Factures été 2026');
  assert.deepEqual(created, { ok: true, value: { path: path.join(documents, 'Factures été 2026'), name: 'Factures été 2026' } });
  assert.ok(statSync(created.value.path).isDirectory());
  assert.deepEqual(readdirSync(created.value.path), []);

  // Renommer.
  const renamed = await files.rename(notes, "Notes de l'été.txt");
  assert.deepEqual(renamed, { ok: true, value: { path: path.join(documents, "Notes de l'été.txt"), name: "Notes de l'été.txt" } });
  assert.equal(existsSync(notes), false);
  assert.equal(digestOf(renamed.value.path), original, 'contenu inchangé');

  // Copier dans un autre dossier : l'original reste, la copie est identique.
  const copied = await files.copy([renamed.value.path], created.value.path, { operation: 'essai-copie' });
  assert.equal(copied.ok, true);
  assert.deepEqual(copied.value.done, [{ source: renamed.value.path, name: "Notes de l'été.txt", path: path.join(created.value.path, "Notes de l'été.txt") }]);
  assert.deepEqual([copied.value.status, copied.value.failed, copied.value.skipped, copied.value.cancelled], ['done', [], [], false]);
  assert.equal(digestOf(copied.value.done[0].path), original);
  assert.equal(digestOf(renamed.value.path), original);

  // Déplacer : confirmation exigée, puis l'élément change de dossier.
  const desktop = path.join(profile, 'Desktop');
  const unconfirmed = await files.move([renamed.value.path], desktop);
  assert.deepEqual([unconfirmed.ok, unconfirmed.code], [false, 'needs-confirmation']);
  assert.equal(existsSync(renamed.value.path), true, 'rien n’a bougé sans confirmation');
  const moved = await files.move([renamed.value.path], desktop, { confirmed: true });
  assert.equal(moved.ok, true);
  assert.equal(moved.value.done[0].path, path.join(desktop, "Notes de l'été.txt"));
  assert.equal(existsSync(renamed.value.path), false);
  assert.equal(digestOf(moved.value.done[0].path), original);

  // Ouvrir : le fichier est confié à l'application associée — par son chemin réel, et rien d'autre.
  const opened = await files.open(moved.value.done[0].path);
  assert.deepEqual(opened, { ok: true, value: { opened: true, path: moved.value.done[0].path, name: "Notes de l'été.txt" } });
  assert.deepEqual(state.opened, [moved.value.done[0].path]);

  // Envoyer à la Corbeille : confirmation exigée ; l'élément quitte son dossier pour la Corbeille, il n'est pas détruit.
  const refused = await files.trash([moved.value.done[0].path]);
  assert.deepEqual([refused.ok, refused.code], [false, 'needs-confirmation']);
  assert.deepEqual(state.trashed, []);
  const trashed = await files.trash([moved.value.done[0].path, created.value.path], { confirmed: true });
  assert.equal(trashed.ok, true);
  assert.deepEqual(trashed.value.done.map((item) => item.name), ["Notes de l'été.txt", 'Factures été 2026']);
  assert.deepEqual(state.trashed.map((item) => item.from), [moved.value.done[0].path, created.value.path]);
  assert.equal(existsSync(moved.value.done[0].path), false);
  assert.equal(existsSync(created.value.path), false);
  assert.equal(digestOf(state.trashed[0].to), original, 'le fichier est intact dans la Corbeille');
  assert.equal(digestOf(path.join(state.trashed[1].to, "Notes de l'été.txt")), original, 'le dossier y est avec son contenu');

  // À la fin : Documents ne contient plus que son dossier d'origine, le Bureau est vide.
  assert.deepEqual(readdirSync(documents), ['Projets été']);
  assert.deepEqual(readdirSync(desktop), []);
});

test('opérations : rien n’est jamais remplacé — nom déjà pris à la création, au renommage, à la copie et au déplacement', async () => {
  const { profile, documents, files } = await launchForOperations();
  const notes = path.join(documents, 'Notes.txt');
  const desktop = path.join(profile, 'Desktop');
  writeFileSync(path.join(desktop, 'Notes.txt'), 'AUTRE contenu, à ne jamais remplacer');
  writeFileSync(path.join(documents, 'Rapport.txt'), 'rapport');
  const before = snapshotOf(profile);
  const other = digestOf(path.join(desktop, 'Notes.txt'));

  assert.equal((await files.createFolder(documents, 'Projets été')).code, 'collision');
  assert.equal((await files.createFolder(documents, 'Notes.txt')).code, 'collision');
  assert.equal((await files.rename(notes, 'Rapport.txt')).code, 'collision');

  // Copie et déplacement : sans choix de l'utilisateur, la question est renvoyée et rien n'est modifié.
  for (const [kind, choices] of [['copy', {}], ['move', { confirmed: true }]]) {
    const asked = await files[kind]([notes], desktop, choices);
    assert.equal(asked.ok, true, kind);
    assert.deepEqual([asked.value.status, asked.value.collisions, asked.value.count], ['collisions', [{ source: notes, name: 'Notes.txt' }], 1], kind);
    // « Remplacer » n'est pas un choix possible.
    for (const onCollision of ['replace', 'overwrite', 'force', true]) {
      assert.equal((await files[kind]([notes], desktop, { ...choices, onCollision })).code, 'bad-arguments', `${kind} ${onCollision}`);
    }
    // « Ignorer » : l'élément est laissé de côté.
    const skipped = await files[kind]([notes], desktop, { ...choices, onCollision: 'skip' });
    assert.deepEqual([skipped.value.done, skipped.value.skipped], [[], [{ source: notes, name: 'Notes.txt', reason: 'collision' }]], kind);
  }
  assert.deepEqual(snapshotOf(profile), before, 'rien n’a été créé, modifié ni supprimé');

  // « Conserver les deux » : la copie reçoit un nouveau nom, l'élément en place est intact.
  const kept = await files.copy([notes], desktop, { onCollision: 'keep-both' });
  assert.equal(kept.value.done[0].path, path.join(desktop, 'Notes - Copie.txt'));
  assert.equal(digestOf(path.join(desktop, 'Notes.txt')), other);
  assert.equal(readFileSync(path.join(desktop, 'Notes - Copie.txt'), 'utf8'), 'bonjour');
  assert.equal(readFileSync(notes, 'utf8'), 'bonjour');
});

test('opérations : un élément créé par un autre programme à l’instant du renommage ou du déplacement n’est pas remplacé', async () => {
  // Le module natif est le vrai ; juste avant chaque demande au système — donc après le constat « ce nom est
  // libre » des opérations —, un autre programme crée un élément du nom d'arrivée.
  const intruded = [];
  const { profile, documents, files } = await launchForOperations({
    loadAtomicMove: () => async (from, to) => {
      writeFileSync(to, 'créé par un autre programme');
      intruded.push(to);
      return nativeMove(from, to);
    },
  });
  const notes = path.join(documents, 'Notes.txt');
  const desktop = path.join(profile, 'Desktop');

  // Renommer : refusé par le système, signalé à la page comme un nom déjà pris.
  const renamed = await files.rename(notes, 'Courrier.txt');
  assert.deepEqual(renamed, { ok: false, code: 'collision', message: 'Un élément porte déjà ce nom à cet endroit. Rien n’a été remplacé.' });
  assert.equal(readFileSync(path.join(documents, 'Courrier.txt'), 'utf8'), 'créé par un autre programme');
  assert.equal(readFileSync(notes, 'utf8'), 'bonjour', 'l’élément à renommer est resté à sa place, intact');

  // Déplacer : même refus, élément par élément.
  const moved = await files.move([notes], desktop, { confirmed: true });
  assert.equal(moved.ok, true);
  assert.deepEqual([moved.value.done, moved.value.failed.map((item) => [item.name, item.code])], [[], [['Notes.txt', 'collision']]]);
  assert.equal(readFileSync(path.join(desktop, 'Notes.txt'), 'utf8'), 'créé par un autre programme');
  assert.equal(readFileSync(notes, 'utf8'), 'bonjour');
  assert.deepEqual(intruded, [path.join(documents, 'Courrier.txt'), path.join(desktop, 'Notes.txt')]);
});

test('opérations : sans le module natif, renommer et déplacer sont refusés — aucun repli — et un auto-test s’arrête en échec', async () => {
  const reason = 'Déplacement sans remplacement : module natif introuvable ou inutilisable (evolve_fs.node) — panne simulée';
  const loadAtomicMove = () => {
    throw new Error(reason);
  };
  const warnings = [];
  const savedWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  cleanups.push(() => (console.warn = savedWarn));

  // Lancement normal : l'application démarre, l'annonce, et refuse de renommer comme de déplacer.
  const { state, profile, documents, files, api } = await launchForOperations({ loadAtomicMove });
  assert.deepEqual(warnings, [`${reason} — renommer et déplacer sont désactivés.`]);
  assert.equal(state.windows.length, 1);
  assert.deepEqual(state.errorBoxes, []);
  const notes = path.join(documents, 'Notes.txt');
  const desktop = path.join(profile, 'Desktop');
  const before = snapshotOf(profile);
  const unavailable = {
    ok: false,
    code: 'move-unavailable',
    message: "Renommer et déplacer ne sont pas disponibles : la fonction du système qui garantit qu'aucun élément n'est remplacé n'a pas pu être chargée. Rien n'a été modifié.",
  };
  assert.deepEqual(await files.rename(notes, 'Courrier.txt'), unavailable);
  assert.deepEqual(await files.rename(path.join(documents, 'Projets été'), 'Projets'), unavailable);
  assert.deepEqual(await files.move([notes], desktop, { confirmed: true }), unavailable);
  assert.deepEqual(snapshotOf(profile), before, 'rien n’a été renommé ni déplacé, d’aucune façon');
  // Les autres opérations restent disponibles : créer un dossier, copier un fichier (refusés par le système si le nom existe).
  assert.equal((await files.createFolder(documents, 'Nouveau')).ok, true);
  assert.deepEqual((await files.copy([notes], desktop)).value.done.map((item) => item.name), ['Notes.txt']);
  // Un dossier ne reçoit son nom que par un déplacement sans remplacement : sa copie n'est pas commencée.
  const folder = await files.copy([path.join(documents, 'Projets été')], desktop);
  assert.deepEqual([folder.value.done, folder.value.failed.map((item) => item.code)], [[], ['move-unavailable']]);
  assert.deepEqual(readdirSync(desktop), ['Notes.txt']);
  assert.equal((await api.services.call('files', 'list', documents)).ok, true, 'la consultation n’est pas touchée');

  // Auto-test : il n'a pas lieu. L'échec et sa cause sont consignés ; l'exécutable ne serait pas publié.
  const outDir = mkdtempSync(path.join(tmpdir(), 'evolve-natif-absent-'));
  cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
  let ran = false;
  const selfTest = await launch({ argv: [`--self-test=${outDir}`], loadAtomicMove, runSelfTest: async () => ((ran = true), 0) });
  assert.equal(ran, false);
  assert.deepEqual(selfTest.state.exitCodes, [1]);
  assert.deepEqual(selfTest.state.errorBoxes, []);
  assert.match(readFileSync(path.join(outDir, 'fatal-error.log'), 'utf8'), /module natif introuvable ou inutilisable \(evolve_fs\.node\) — panne simulée/);
});

test('opérations : si la Corbeille ne peut pas recevoir un élément, il reste à sa place — aucune suppression définitive', async () => {
  const { state, profile, documents, files } = await launchForOperations();
  const notes = path.join(documents, 'Notes.txt');
  const before = snapshotOf(profile);
  // Windows abandonne l'opération (lecteur sans Corbeille, élément trop volumineux…).
  state.recycleBin = false;

  const reply = await files.trash([notes, path.join(documents, 'Projets été')], { confirmed: true });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.value.done, []);
  assert.deepEqual(reply.value.failed.map((item) => [item.name, item.code]), [['Notes.txt', 'trash-failed'], ['Projets été', 'trash-failed']]);
  assert.match(reply.value.failed[0].message, /n'a pas été supprimé et reste à sa place/);
  assert.deepEqual(snapshotOf(profile), before);
  assert.equal(readFileSync(notes, 'utf8'), 'bonjour');
  assert.deepEqual(state.trashed, []);

  // Un déplacement, lui, ne passe jamais par la Corbeille quand il reste sur le même lecteur.
  const moved = await files.move([notes], path.join(profile, 'Desktop'), { confirmed: true });
  assert.equal(moved.value.done.length, 1);
  assert.equal(readFileSync(path.join(profile, 'Desktop', 'Notes.txt'), 'utf8'), 'bonjour');
});

test('opérations : un programme ou un script n’est ouvert qu’après confirmation ; un échec de Windows est signalé', async () => {
  const { state, documents, files } = await launchForOperations();
  const script = path.join(documents, 'Installer.cmd');
  writeFileSync(script, '@echo off\r\n');
  const notes = path.join(documents, 'Notes.txt');

  const asked = await files.open(script);
  assert.deepEqual([asked.ok, asked.code], [false, 'needs-confirmation']);
  assert.match(asked.message, /exécute du code sur cet ordinateur/);
  assert.equal((await files.open(script, { confirmed: false })).code, 'needs-confirmation');
  assert.deepEqual(state.opened, [], 'rien n’a été confié à Windows');
  assert.equal((await files.open(script, { confirmed: true })).ok, true);
  assert.deepEqual(state.opened, [script]);

  // Sûr par défaut : un type de fichier inconnu, un fichier sans extension et un script nommé « .cmd »
  // ne sont pas ouverts sans confirmation non plus.
  for (const [name, wording] of [['Données.xyz', /ne connaît pas ce type de fichier/], ['SANS EXTENSION', /ne connaît pas ce type de fichier/], ['.cmd', /exécute du code sur cet ordinateur/]]) {
    writeFileSync(path.join(documents, name), 'essai');
    const reply = await files.open(path.join(documents, name));
    assert.deepEqual([reply.ok, reply.code], [false, 'needs-confirmation'], name);
    assert.match(reply.message, wording, name);
  }
  assert.deepEqual(state.opened, [script], 'rien d’autre n’a été confié à Windows');

  // Un dossier ne s'ouvre pas ainsi ; un élément absent non plus.
  assert.equal((await files.open(path.join(documents, 'Projets été'))).code, 'not-a-file');
  assert.equal((await files.open(path.join(documents, 'Introuvable.txt'))).code, 'not-found');
  // Windows ne sait pas ouvrir ce fichier : l'échec est rapporté, sans détail du système.
  state.openResult = 'Failed to open path';
  assert.deepEqual(await files.open(notes), { ok: false, code: 'open-failed', message: "Windows n'a pas pu ouvrir ce fichier : aucune application ne lui est peut-être associée." });
  assert.deepEqual(state.opened, [script, notes]);
});

test('opérations : les emplacements de base, les chemins hors de l’ordinateur et les noms interdits sont refusés avant tout accès', async () => {
  const { state, profile, documents, files, tempDir } = await launchForOperations();
  const notes = path.join(documents, 'Notes.txt');
  const projects = path.join(documents, 'Projets été');
  mkdirSync(path.join(projects, 'Sous-dossier'));
  // « AppData » du faux profil : désigné par les variables APPDATA et LOCALAPPDATA le temps de l'essai.
  const appData = path.join(profile, 'AppData');
  mkdirSync(path.join(appData, 'Local', 'Programme'), { recursive: true });
  // Lien vers le dossier du profil (jonction sous Windows : aucun droit particulier n'est nécessaire).
  symlinkSync(profile, path.join(profile, 'Détour'), 'junction');
  const before = snapshotOf(tempDir);
  const code = async (pending) => {
    const reply = await pending;
    return reply.ok ? 'accepté' : reply.code;
  };
  const { root } = path.parse(profile);

  // Un dossier personnel et un lecteur ne se renomment pas, ne se déplacent pas, ne se suppriment pas.
  assert.equal(await code(files.rename(documents, 'Mes documents')), 'protected');
  assert.equal(await code(files.trash([documents], { confirmed: true })), 'protected');
  assert.equal(await code(files.move([documents], path.join(profile, 'Desktop'), { confirmed: true })), 'protected');
  assert.equal(await code(files.trash([root], { confirmed: true })), 'protected');
  assert.equal(await code(files.rename(root, 'Disque')), 'protected');
  // Ni le dossier qui les contient.
  assert.equal(await code(files.trash([profile], { confirmed: true })), 'protected');
  assert.equal(await code(files.rename(profile, 'profil 2')), 'protected');
  // Désigné par un autre chemin — à travers un lien —, un dossier personnel reste intouchable : c'est
  // l'emplacement réel qui compte. Le lien lui-même n'est pas modifié non plus.
  const detour = path.join(profile, 'Détour', 'Documents');
  assert.equal(await code(files.trash([detour], { confirmed: true })), 'protected');
  assert.equal(await code(files.rename(detour, 'Mes documents')), 'protected');
  assert.equal(await code(files.move([detour], path.join(profile, 'Desktop'), { confirmed: true })), 'protected');
  // Et le refus dit ce qu'il est — un dossier personnel —, par un chemin comme par l'autre.
  assert.match((await files.rename(detour, 'Mes documents')).message, /^Cet emplacement est un lecteur ou un dossier personnel/);
  assert.equal((await files.rename(detour, 'Mes documents')).message, (await files.rename(documents, 'Mes documents')).message);
  assert.match((await files.rename(profile, 'profil 2')).message, /^Ce dossier contient un dossier personnel/);
  assert.equal(await code(files.trash([path.join(profile, 'Détour')], { confirmed: true })), 'link-not-supported');
  assert.equal(await code(files.rename(path.join(profile, 'Détour'), 'Autre')), 'link-not-supported');

  // Chemins relatifs, remontées, noms réservés : refusés sur leur seule forme.
  for (const target of ['Notes.txt', '..', '', `${documents}${path.sep}..${path.sep}..`, `${documents}${path.sep}.${path.sep}Notes.txt`]) {
    assert.equal(await code(files.createFolder(target, 'Dossier')), 'invalid-path', JSON.stringify(target));
    assert.equal(await code(files.trash([target], { confirmed: true })), 'invalid-path', JSON.stringify(target));
    assert.equal(await code(files.copy([notes], target)), 'invalid-path', JSON.stringify(target));
    assert.equal(await code(files.open(target)), 'invalid-path', JSON.stringify(target));
  }
  for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', 'CON', 'nul.txt', 'COM1', 'nom.', 'nom ', ' nom', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'x'.repeat(256)]) {
    assert.equal(await code(files.createFolder(documents, name)), 'invalid-name', JSON.stringify(name));
    assert.equal(await code(files.rename(notes, name)), 'invalid-name', JSON.stringify(name));
  }
  // Arguments d'une autre nature : refusés, jamais d'exception.
  for (const value of [null, undefined, 42, {}, ['x'], true]) {
    assert.equal(await code(files.createFolder(value, 'Dossier')), 'bad-arguments', String(value));
    assert.equal(await code(files.rename(value, 'Nom')), 'bad-arguments', String(value));
    assert.equal(await code(files.open(value)), 'bad-arguments', String(value));
  }
  assert.equal(await code(files.trash(notes, { confirmed: true })), 'bad-arguments', 'une liste est attendue');
  assert.equal(await code(files.trash([], { confirmed: true })), 'bad-arguments');
  assert.equal(await code(files.trash([notes], { confirmed: true, force: true })), 'bad-arguments', 'option inconnue');
  assert.equal(await code(files.trash([notes], { confirmed: 'oui' })), 'bad-arguments');
  assert.equal(await code(files.copy([notes], documents, { operation: '../x' })), 'bad-arguments');
  assert.equal(await code(files.copy(new Array(1001).fill(notes), documents)), 'bad-arguments', 'mille éléments au plus');
  // Une demande impossible à transmettre (ici, une fonction) : réponse d'échec, jamais d'exception.
  assert.deepEqual(await files.createFolder(documents, () => 'nom'), { ok: false, code: 'failed', message: "La demande n'a pas pu être transmise." });

  // Un dossier ne se copie ni ne se déplace dans lui-même, ni dans l'un de ses sous-dossiers.
  assert.equal(await code(files.copy([projects], path.join(projects, 'Sous-dossier'))), 'into-itself');
  assert.equal(await code(files.move([projects], path.join(projects, 'Sous-dossier'), { confirmed: true })), 'into-itself');
  assert.equal(await code(files.move([projects], projects, { confirmed: true })), 'into-itself');
  // Une sélection ne peut pas contenir un dossier et l'un de ses éléments.
  assert.equal(await code(files.trash([projects, path.join(projects, 'Sous-dossier')], { confirmed: true })), 'invalid-selection');

  if (ON_WINDOWS) {
    // Partage réseau, espace de noms, flux, périphérique : jamais atteints.
    for (const target of ['\\\\localhost\\C$', '\\\\?\\C:\\', '\\\\.\\C:\\', 'C:', 'C:Users', `${notes}:flux`, `${documents}\\NUL`]) {
      assert.equal(await code(files.createFolder(target, 'Dossier')), 'invalid-path', target);
      assert.equal(await code(files.trash([target], { confirmed: true })), 'invalid-path', target);
    }
    // Dossier de Windows : rien n'y est créé (la demande est refusée sur l'emplacement, sans aucune tentative d'écriture).
    const windows = process.env.SystemRoot;
    assert.equal(await code(files.createFolder(windows, 'Evolve-essai')), 'protected');
    assert.equal(existsSync(path.join(windows, 'Evolve-essai')), false);
    // Le dossier « AppData » du compte (ici, celui du faux profil) est préservé : rien n'y est créé, renommé,
    // déplacé ni supprimé — mais un élément peut y être lu pour être copié ailleurs.
    const program = path.join(appData, 'Local', 'Programme');
    assert.equal(await code(files.createFolder(path.join(appData, 'Local'), 'Evolve-essai')), 'protected');
    assert.equal(await code(files.rename(program, 'Autre nom')), 'protected');
    assert.equal(await code(files.trash([program], { confirmed: true })), 'protected');
    assert.equal(await code(files.move([program], documents, { confirmed: true })), 'protected');
    assert.equal(await code(files.copy([notes], program)), 'protected');
    assert.equal(await code(files.trash([appData], { confirmed: true })), 'protected');
  }

  assert.deepEqual(snapshotOf(tempDir), before, 'aucune de ces demandes n’a modifié quoi que ce soit');
  assert.deepEqual(state.trashed, []);
  assert.deepEqual(state.opened, []);
});

test('opérations : elles ne sont pas des méthodes de service — le canal des services ne les atteint pas', async () => {
  const { state, documents, api, tempDir } = await launchForOperations();
  const notes = path.join(documents, 'Notes.txt');
  const before = snapshotOf(tempDir);
  const code = async (...args) => (await api.services.call(...args)).code;

  for (const method of ['createFolder', 'rename', 'copy', 'move', 'trash', 'open', 'cancel', 'onProgress', 'delete', 'remove', 'write', 'guard']) {
    assert.equal(await code('files', method, notes, 'Nom'), 'unknown-method', method);
  }
  for (const service of ['file-operations', 'fileOperations', 'operations', 'files.operations']) {
    assert.equal(await code(service, 'trash', [notes], { confirmed: true }), 'unknown-service', service);
  }
  assert.deepEqual(snapshotOf(tempDir), before);
  assert.deepEqual(state.trashed, []);
});

test('opérations : les demandes d’une autre page sont refusées, sur chacun des sept canaux', async () => {
  const { fake, state, documents, tempDir } = await launchForOperations();
  const notes = path.join(documents, 'Notes.txt');
  const before = snapshotOf(tempDir);
  // Une autre page (cadre, fenêtre ou contenu inattendu) : ses messages ne viennent pas de la fenêtre de l'application.
  const intruder = fake.rendererFor(new fake.window.webContents.constructor());
  const refused = { ok: false, code: 'forbidden', message: 'Appel refusé.' };

  const attempts = [
    ['evolve:files-create-folder', documents, 'Intrus'],
    ['evolve:files-rename', notes, 'Intrus.txt'],
    ['evolve:files-copy', [notes], path.join(documents, 'Projets été'), null],
    ['evolve:files-move', [notes], path.join(documents, 'Projets été'), { confirmed: true }],
    ['evolve:files-trash', [notes], { confirmed: true }],
    ['evolve:files-open', notes, { confirmed: true }],
    ['evolve:files-cancel', 'operation-1'],
  ];
  for (const [channel, ...args] of attempts) {
    assert.deepEqual(await intruder.invoke(channel, ...args), refused, channel);
  }
  // Les sept canaux des opérations ont tous été éprouvés.
  assert.deepEqual(attempts.map(([channel]) => channel).sort(), [...state.ipcHandlers.keys()].filter((name) => name.startsWith('evolve:files-')).sort());
  assert.deepEqual(snapshotOf(tempDir), before, 'rien n’a été créé, renommé, copié, déplacé ni supprimé');
  assert.deepEqual(state.trashed, []);
  assert.deepEqual(state.opened, []);
});

test('opérations : l’avancement est transmis à la fenêtre, et une opération peut être interrompue', async () => {
  const { fake, state, documents, files } = await launchForOperations();
  const source = path.join(documents, 'Gros dossier');
  mkdirSync(source);
  for (let index = 1; index <= 40; index += 1) writeFileSync(path.join(source, `fichier ${String(index).padStart(2, '0')}.txt`), `contenu ${index}`);
  const target = path.join(documents, 'Projets été');

  const seen = [];
  const unsubscribe = files.onProgress((progress) => seen.push(progress));
  assert.equal(typeof files.onProgress('pas une fonction'), 'function');

  const reply = await files.copy([source], target, { operation: 'copie-suivie' });
  assert.equal(reply.ok, true);
  assert.equal(readdirSync(path.join(target, 'Gros dossier')).length, 40);
  // Au moins l'annonce de fin ; chaque annonce désigne l'opération par l'identifiant fourni.
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen.at(-1), { operation: 'copie-suivie', kind: 'copy', state: 'finished' });
  for (const progress of seen) assert.equal(progress.operation, 'copie-suivie');
  for (const progress of seen.filter((item) => item.state === 'running')) {
    assert.deepEqual([progress.kind, progress.total], ['copy', 41]);
    assert.ok(progress.done >= 1 && progress.done <= 41 && typeof progress.current === 'string');
  }
  // Tout est passé par le canal de l'avancement, vers la fenêtre de l'application.
  const sent = fake.window.webContents.sent.filter(([channel]) => channel === 'evolve:files-progress');
  assert.deepEqual(sent.map(([, progress]) => progress), seen);

  // Interruption : demandée dès la première annonce, l'opération s'arrête ; ce qui a été copié reste, sous un nom qui le dit.
  seen.length = 0;
  let asked = null;
  const stop = files.onProgress((progress) => {
    if (progress.state === 'running' && asked === null) asked = files.cancel('copie-interrompue');
  });
  const interrupted = await files.copy([source], documents, { operation: 'copie-interrompue' });
  stop();
  // La première étape d'une opération est toujours annoncée : l'arrêt a donc été demandé dès le dossier créé.
  assert.notEqual(asked, null);
  assert.deepEqual(await asked, { ok: true, value: true });
  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.value.cancelled, true);
  assert.deepEqual(interrupted.value.done, []);
  assert.deepEqual(interrupted.value.failed, []);
  // Ce qui a été copié reste sur le disque, sous un nom qui dit que la copie est incomplète.
  const partial = 'Gros dossier - Copie (copie incomplète)';
  assert.deepEqual(interrupted.value.skipped, [{ source, name: 'Gros dossier', reason: 'cancelled', partial }]);
  assert.ok(readdirSync(path.join(documents, partial)).length < 40);
  assert.deepEqual(readdirSync(documents).sort(), ['Gros dossier', partial, 'Notes.txt', 'Projets été'].sort());
  assert.equal(readdirSync(source).length, 40, 'le dossier d’origine est intact');

  // Aucune opération en cours : il n'y a rien à interrompre.
  assert.deepEqual(await files.cancel('copie-interrompue'), { ok: true, value: false });
  assert.deepEqual(await files.cancel(42), { ok: true, value: false });

  // Après désabonnement, l'abonné n'est plus appelé — la fenêtre, elle, reçoit toujours l'annonce.
  unsubscribe();
  const count = seen.length;
  const sentBefore = fake.window.webContents.sent.length;
  assert.equal((await files.createFolder(documents, 'Après désabonnement')).ok, true);
  assert.equal(seen.length, count);
  assert.deepEqual(fake.window.webContents.sent.slice(sentBefore).map(([channel, progress]) => [channel, progress.kind, progress.state]), [['evolve:files-progress', 'create-folder', 'finished']]);

  // Fenêtre fermée : plus aucune demande n'est acceptée, plus rien ne lui est envoyé.
  const sentAtClose = fake.window.webContents.sent.length;
  fake.window.close();
  const late = await state.ipcHandlers.get('evolve:files-create-folder')({ sender: fake.window.webContents }, documents, 'Fenêtre fermée');
  assert.deepEqual(late, { ok: false, code: 'forbidden', message: 'Appel refusé.' });
  assert.equal(existsSync(path.join(documents, 'Fenêtre fermée')), false);
  assert.equal(fake.window.webContents.sent.length, sentAtClose);
});

test('opérations : douze fenêtres de l’explorateur suivent l’avancement par un seul écouteur du canal', async (t) => {
  const { fake, documents, files } = await launchForOperations();
  const listeners = () => fake.window.webContents.rendererListeners.get('evolve:files-progress') ?? [];
  // L'écouteur est posé au chargement de la passerelle, avant tout abonnement.
  assert.equal(listeners().length, 1);

  // Douze fenêtres ouvertes à la fois — le plus grand nombre que le bureau accepte : chacune s'abonne.
  // (Avec un écouteur par abonné, le vrai Electron signalait une fuite possible à la onzième ; le faux refuse.)
  const seen = Array.from({ length: 12 }, () => []);
  const stops = seen.map((list) => files.onProgress((progress) => list.push(progress)));
  assert.equal(listeners().length, 1);

  assert.equal((await files.createFolder(documents, 'Un')).ok, true);
  for (const list of seen) assert.deepEqual(list.map((progress) => [progress.kind, progress.state]), [['create-folder', 'finished']]);

  // Une fenêtre se ferme : elle seule n'est plus informée.
  stops[4]();
  stops[4](); // se désabonner deux fois est sans effet
  assert.equal((await files.createFolder(documents, 'Deux')).ok, true);
  assert.deepEqual(seen.map((list) => list.length), [2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2]);
  assert.equal(listeners().length, 1);

  // Une même fonction abonnée deux fois est appelée deux fois ; chaque abonnement se retire séparément.
  const twice = [];
  const note = (progress) => twice.push(progress.state);
  const [first, second] = [files.onProgress(note), files.onProgress(note)];
  assert.equal((await files.createFolder(documents, 'Trois')).ok, true);
  assert.deepEqual(twice, ['finished', 'finished']);
  first();
  assert.equal((await files.createFolder(documents, 'Quatre')).ok, true);
  assert.deepEqual(twice, ['finished', 'finished', 'finished']);
  second();

  // Un abonné qui échoue ne prive pas les suivants de l'annonce ; sa panne est écrite dans la console.
  const reported = t.mock.method(console, 'error', () => {});
  const broken = files.onProgress(() => {
    throw new Error('abonné en panne');
  });
  const after = [];
  const last = files.onProgress((progress) => after.push(progress.state));
  const before = seen[0].length;
  assert.equal((await files.createFolder(documents, 'Cinq')).ok, true);
  assert.equal(seen[0].length, before + 1);
  assert.deepEqual(after, ['finished']);
  assert.equal(reported.mock.callCount(), 1);
  assert.match(String(reported.mock.calls[0].arguments[0]), /abonné à l'avancement/);
  assert.equal(reported.mock.calls[0].arguments[1].message, 'abonné en panne');
  broken();
  last();

  // Une fenêtre qui se ferme pendant une annonce — ici, la première ferme la dernière — n'est plus appelée.
  const closing = [];
  let stopLate = () => {};
  const stopEarly = files.onProgress(() => {
    closing.push('première');
    stopLate();
  });
  stopLate = files.onProgress(() => closing.push('dernière'));
  assert.equal((await files.createFolder(documents, 'Six')).ok, true);
  assert.deepEqual(closing, ['première']);
  stopEarly();

  // Toutes les fenêtres fermées : plus personne n'est informé, et l'écouteur unique reste en place.
  for (const stop of stops) stop();
  const counts = seen.map((list) => list.length);
  assert.equal((await files.createFolder(documents, 'Sept')).ok, true);
  assert.deepEqual(seen.map((list) => list.length), counts);
  assert.equal(listeners().length, 1);
  assert.equal(reported.mock.callCount(), 1);
});

test('faux Electron : un onzième écouteur sur un même canal est refusé, comme le vrai le signalerait', async () => {
  const fake = await launch();
  const renderer = fake.rendererFor(fake.window.webContents);
  for (let index = 0; index < 10; index += 1) renderer.on('evolve:essai', () => {});
  assert.throws(() => renderer.on('evolve:essai', () => {}), /plus de 10 écouteurs sur « evolve:essai »/);
  // Un autre canal n'est pas concerné.
  renderer.on('evolve:autre', () => {});
});

test('opérations : l’inventaire des services les décrit — Corbeille seulement, aucun remplacement', async () => {
  let describe;
  const fake = await launch({
    argv: [`--self-test=${path.join(tmpdir(), 'evolve-inutilise')}`],
    runSelfTest: async (_win, options) => {
      describe = options.describeServices;
      return 0;
    },
  });
  assert.deepEqual(describe()['file-operations'], {
    state: 'available',
    access: 'dedicated-functions',
    busy: false,
    trash: true,
    open: true,
    noReplaceMove: true,
    deletion: 'recycle-bin-only',
    replace: 'never',
    methods: ['createFolder', 'rename', 'copy', 'move', 'trash', 'open'],
    events: ['progress'],
  });
  // Le service de consultation, lui, reste en lecture seule.
  assert.deepEqual([describe().files.access, describe().files.methods], ['read-only', ['places', 'list']]);
  assert.deepEqual(fake.state.exitCodes, [0]);
});

test('opérations : de la commande de l’explorateur jusqu’au disque — navigation, presse-papiers, questions et demandes réelles', async () => {
  const { state, profile, documents, api } = await launchForOperations();
  const { Navigator } = await import('../src/renderer/js/apps/explorer-nav.js');
  const { FileActions, createFileClipboard } = await import('../src/renderer/js/apps/explorer-actions.js');
  const { createFileOperationsClient } = await import('../src/renderer/js/core/file-operations.js');
  const { createServiceClient } = await import('../src/renderer/js/core/services.js');

  // L'explorateur tel qu'il est assemblé dans la fenêtre (apps/explorer.js) : seuls l'affichage et les fenêtres
  // de dialogue sont remplacés. Navigation, commandes, passerelle, processus principal, services et disque sont réels.
  const services = createServiceClient(api.services);
  const nav = new Navigator({
    files: { available: services.available, places: () => services.call('files', 'places'), list: (target) => services.call('files', 'list', target) },
  });
  const answers = { prompt: [], confirm: [], choose: [] };
  const asked = [];
  const toasts = [];
  const informed = [];
  let selected = [];
  const take = (kind, title) => {
    asked.push(`${kind} : ${title}`);
    assert.ok(answers[kind].length > 0, `question inattendue (${kind}) : ${title}`);
    return answers[kind].shift();
  };
  const clipboard = createFileClipboard();
  const actions = new FileActions({
    operations: createFileOperationsClient(api.files),
    dialogs: {
      async prompt(options) {
        for (;;) {
          const typed = take('prompt', options.title);
          if (typed === null) return null;
          const problem = await options.onSubmit(typed);
          if (problem === null) return typed;
          asked.push(`refus : ${problem}`);
        }
      },
      confirm: async (options) => take('confirm', options.title),
      choose: async (options) => take('choose', options.title),
      inform: async (options) => void informed.push([options.title, options.message, options.details]),
      progress: () => ({ update() {}, close() {} }),
    },
    toasts: { show: (toast) => toasts.push([toast.title, toast.message]) },
    clipboard,
    view: {
      page: () => (nav.loading ? null : nav.page),
      reload: () => nav.reload(),
      select: (paths) => (selected = paths),
      changed: () => {},
    },
  });
  /** Éléments affichés, par nom. */
  const shown = () => Object.fromEntries(nav.page.sections.flatMap((section) => section.nodes).map((node) => [node.name, node]));
  const names = () => Object.keys(shown()).sort();
  const desktop = path.join(profile, 'Desktop');

  // Accueil : rien n'y est créé ni collé, et un dossier personnel n'est l'objet d'aucune opération.
  await nav.open('home');
  assert.deepEqual(actions.commands([]), { open: false, cut: false, copy: false, rename: false, trash: false, paste: false, newFolder: false });
  const browseOnly = { open: true, cut: false, copy: false, rename: false, trash: false, paste: false, newFolder: false };
  assert.deepEqual(actions.commands([shown().Documents]), browseOnly);
  await actions.trash([shown().Documents]);
  await actions.rename(shown().Documents);
  // Le même dossier personnel, vu dans le dossier qui le contient : il se parcourt, sans plus.
  await nav.open({ type: 'folder', path: profile, name: 'profil' });
  const personal = shown().Documents;
  assert.deepEqual([personal.path, personal.place], [documents, 'documents']);
  assert.deepEqual(actions.commands([personal]), { ...browseOnly, newFolder: true });
  await actions.trash([personal]);
  await actions.rename(personal);
  actions.cut([personal]);
  assert.deepEqual([asked, state.trashed, clipboard.size], [[], [], 0]);

  // Documents : nouveau dossier — un nom refusé par l'application de bureau, puis un nom admis.
  await nav.open('documents');
  assert.deepEqual(names(), ['Notes.txt', 'Projets été']);
  answers.prompt.push('Projets été', 'Factures 2026');
  await actions.newFolder();
  assert.deepEqual(asked, ['prompt : Nouveau dossier', 'refus : Un élément porte déjà ce nom à cet endroit. Rien n’a été remplacé.', 'prompt : Nouveau dossier']);
  assert.ok(statSync(path.join(documents, 'Factures 2026')).isDirectory());
  assert.deepEqual(names(), ['Factures 2026', 'Notes.txt', 'Projets été'], 'le dossier affiché a été relu');
  assert.deepEqual(selected, [path.join(documents, 'Factures 2026')]);
  assert.deepEqual(toasts.at(-1), ['Dossier créé', '« Factures 2026 » a été créé dans « Documents ».']);

  // Renommer le fichier.
  asked.length = 0;
  answers.prompt.push('Notes de réunion.txt');
  await actions.rename(shown()['Notes.txt']);
  assert.deepEqual(names(), ['Factures 2026', 'Notes de réunion.txt', 'Projets été']);
  assert.equal(readFileSync(path.join(documents, 'Notes de réunion.txt'), 'utf8'), 'bonjour');
  assert.deepEqual(selected, [path.join(documents, 'Notes de réunion.txt')]);
  assert.deepEqual(toasts.at(-1), ['Élément renommé', "« Notes.txt » s'appelle maintenant « Notes de réunion.txt »."]);

  // Copier, puis coller dans le nouveau dossier : aucune question, l'original reste.
  asked.length = 0;
  actions.copy([shown()['Notes de réunion.txt']]);
  assert.deepEqual(readdirSync(documents).sort(), ['Factures 2026', 'Notes de réunion.txt', 'Projets été'], 'copier ne modifie rien');
  await nav.open(shown()['Factures 2026'].location);
  assert.deepEqual(names(), []);
  await actions.paste();
  assert.deepEqual(names(), ['Notes de réunion.txt']);
  assert.deepEqual(selected, [path.join(documents, 'Factures 2026', 'Notes de réunion.txt')]);
  assert.deepEqual(toasts.at(-1), ['Copie terminée', '« Notes de réunion.txt » a été copié dans « Factures 2026 ».']);
  assert.deepEqual(asked, []);

  // Coller de nouveau : le nom est pris. « Ignorer » ne change rien ; « Conserver les deux » crée une copie à côté.
  const before = digestOf(path.join(documents, 'Factures 2026', 'Notes de réunion.txt'));
  answers.choose.push('skip');
  await actions.paste();
  assert.deepEqual(asked, ['choose : « Notes de réunion.txt » existe déjà']);
  assert.deepEqual(names(), ['Notes de réunion.txt']);
  assert.deepEqual(toasts.at(-1), ['Aucun élément copié', 'Un élément a été ignoré : son nom était déjà pris.']);
  answers.choose.push(null);
  await actions.paste();
  assert.deepEqual(names(), ['Notes de réunion.txt'], 'question abandonnée : rien');
  answers.choose.push('keep-both');
  await actions.paste();
  assert.deepEqual(names(), ['Notes de réunion - Copie.txt', 'Notes de réunion.txt']);
  assert.equal(digestOf(path.join(documents, 'Factures 2026', 'Notes de réunion.txt')), before, 'l’élément en place est intact');
  assert.deepEqual(selected, [path.join(documents, 'Factures 2026', 'Notes de réunion - Copie.txt')]);
  assert.deepEqual(toasts.at(-1), ['Copie terminée', '« Notes de réunion - Copie.txt » a été créé dans « Factures 2026 ».']);

  // Couper, puis coller sur le Bureau : confirmation refusée, puis donnée.
  asked.length = 0;
  actions.cut([shown()['Notes de réunion - Copie.txt']]);
  assert.equal(clipboard.isCut(path.join(documents, 'Factures 2026', 'Notes de réunion - Copie.txt')), true);
  await nav.open('desktop');
  answers.confirm.push(false);
  await actions.paste();
  assert.deepEqual([names(), readdirSync(path.join(documents, 'Factures 2026')).sort()], [[], ['Notes de réunion - Copie.txt', 'Notes de réunion.txt']], 'sans confirmation, rien ne bouge');
  answers.confirm.push(true);
  await actions.paste();
  assert.deepEqual(asked, ['confirm : Déplacer « Notes de réunion - Copie.txt » ?', 'confirm : Déplacer « Notes de réunion - Copie.txt » ?']);
  assert.deepEqual(names(), ['Notes de réunion - Copie.txt']);
  assert.deepEqual(readdirSync(path.join(documents, 'Factures 2026')), ['Notes de réunion.txt']);
  assert.deepEqual(toasts.at(-1), ['Déplacement terminé', '« Notes de réunion - Copie.txt » a été déplacé vers « Bureau ».']);
  assert.equal(clipboard.size, 0);

  // Envoyer à la Corbeille : confirmation refusée, puis donnée.
  asked.length = 0;
  answers.confirm.push(false);
  await actions.trash([shown()['Notes de réunion - Copie.txt']]);
  assert.deepEqual([readdirSync(desktop), state.trashed], [['Notes de réunion - Copie.txt'], []]);
  answers.confirm.push(true);
  await actions.trash([shown()['Notes de réunion - Copie.txt']]);
  assert.deepEqual(asked, ['confirm : Envoyer « Notes de réunion - Copie.txt » à la Corbeille ?', 'confirm : Envoyer « Notes de réunion - Copie.txt » à la Corbeille ?']);
  assert.deepEqual([names(), readdirSync(desktop)], [[], []]);
  assert.deepEqual(state.trashed.map((item) => item.from), [path.join(desktop, 'Notes de réunion - Copie.txt')]);
  assert.equal(readFileSync(state.trashed[0].to, 'utf8'), 'bonjour', 'l’élément est dans la Corbeille, intact');
  assert.deepEqual(toasts.at(-1), ['Envoyé à la Corbeille', '« Notes de réunion - Copie.txt » a été envoyé à la Corbeille de Windows.']);

  // Ouvrir : un document est confié à Windows ; un script, seulement après confirmation.
  asked.length = 0;
  writeFileSync(path.join(desktop, 'Lancer.cmd'), '@echo off\r\n');
  await nav.open('documents');
  await actions.open(shown()['Notes de réunion.txt']);
  assert.deepEqual([state.opened, asked], [[path.join(documents, 'Notes de réunion.txt')], []]);
  await nav.open('desktop');
  answers.confirm.push(false);
  await actions.open(shown()['Lancer.cmd']);
  assert.equal(state.opened.length, 1, 'sans confirmation, le script n’est pas confié à Windows');
  answers.confirm.push(true);
  await actions.open(shown()['Lancer.cmd']);
  assert.deepEqual(asked, ['confirm : Ouvrir « Lancer.cmd » ?', 'confirm : Ouvrir « Lancer.cmd » ?']);
  assert.deepEqual(state.opened, [path.join(documents, 'Notes de réunion.txt'), path.join(desktop, 'Lancer.cmd')]);

  // La Corbeille refuse : l'élément reste, et une fenêtre le dit.
  state.recycleBin = false;
  answers.confirm.push(true);
  await actions.trash([shown()['Lancer.cmd']]);
  assert.deepEqual(names(), ['Lancer.cmd']);
  assert.deepEqual(informed.at(-1), [
    'Envoi à la Corbeille impossible',
    "Un élément n'a pas pu être traité :",
    ["« Lancer.cmd » : Windows n'a pas pu envoyer cet élément à la Corbeille : il n'a pas été supprimé et reste à sa place."],
  ]);

  // État final du disque : exactement ce que l'utilisateur a demandé, rien de plus.
  assert.deepEqual(readdirSync(documents).sort(), ['Factures 2026', 'Notes de réunion.txt', 'Projets été']);
  assert.deepEqual(readdirSync(path.join(documents, 'Factures 2026')), ['Notes de réunion.txt']);
  assert.deepEqual(readdirSync(path.join(documents, 'Projets été')), []);
  assert.deepEqual(readdirSync(desktop), ['Lancer.cmd']);
  assert.deepEqual(answers, { prompt: [], confirm: [], choose: [] }, 'chaque réponse préparée a servi');
});
