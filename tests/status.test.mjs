/**
 * Compte rendu de démarrage de l'application (src/main/status.js), exécuté
 * ici contre une fausse fenêtre : l'état écrit doit refléter fidèlement la
 * fenêtre, et l'attente ne doit jamais rester bloquée.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { reportStatus, captureFileFor, DEFAULT_TIMINGS, READY_CODE } = require('../src/main/status.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-status-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Durées très courtes : les tests ne patientent pas. */
const FAST = { ready: 200, poll: 5, response: 50, settle: 0 };

let sequence = 0;
const freshFile = () => path.join(workDir, `essai-${(sequence += 1)}`, 'etat.json');

const DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

/** Faux module `screen` d'Electron. */
const screen = {
  requested: [],
  getDisplayMatching(bounds) {
    this.requested.push(bounds);
    return DISPLAY;
  },
};

/** Contenu de l'image « dessinée » par la fausse fenêtre. */
const PNG_BYTES = Buffer.from('image PNG simulée');

/**
 * Fausse fenêtre d'application.
 * @param {(code: string, win: object) => unknown} [answer] réponse de la page au code exécuté
 * @param {object} [state] état de la fenêtre ; `capturePage` remplace la capture de la page
 */
function createWindow(answer = () => true, { capturePage, ...state } = {}) {
  const webContents = new EventEmitter();
  webContents.executed = [];
  webContents.captures = 0;
  webContents.capturePage = async () => {
    webContents.captures += 1;
    return capturePage ? capturePage() : { toPNG: () => PNG_BYTES };
  };
  const win = {
    webContents,
    destroyed: false,
    visible: true,
    fullScreen: true,
    minimized: false,
    focused: true,
    bounds: { x: 0, y: 0, width: 1920, height: 1080, extra: 'ignoré' },
    ...state,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    isFullScreen() {
      return this.fullScreen;
    },
    isMinimized() {
      return this.minimized;
    },
    isFocused() {
      return this.focused;
    },
    getTitle: () => 'Evolve',
    getBounds() {
      return this.bounds;
    },
  };
  webContents.executeJavaScript = async (code, userGesture) => {
    webContents.executed.push([code, userGesture]);
    return answer(code, win);
  };
  return win;
}

async function run(win, timings = FAST) {
  const file = freshFile();
  const returned = await reportStatus(win, { file, screen, timings });
  const written = JSON.parse(readFileSync(file, 'utf8'));
  return { file, returned, written };
}

test('interface démarrée en plein écran : état complet écrit dans le fichier', async () => {
  const win = createWindow();
  const { file, returned, written } = await run(win);

  assert.deepEqual(written, returned, 'le fichier contient exactement l’état renvoyé');
  assert.equal(written.ready, true);
  assert.equal(written.closed, false);
  assert.equal(written.visible, true);
  assert.equal(written.fullscreen, true);
  assert.equal(written.minimized, false);
  assert.equal(written.focused, true);
  assert.equal(written.title, 'Evolve');
  assert.deepEqual(written.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(written.display, { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 });
  assert.equal(written.pid, process.pid);
  assert.equal(written.executable, process.execPath);
  assert.equal(written.userData, null, 'dossier des données : seulement s’il est indiqué');
  assert.deepEqual(written.errors, []);
  assert.ok(written.startupMs >= 0);
  assert.deepEqual(Object.keys(written.versions), ['electron', 'chrome']);

  // Une seule question a suffi ; aucun fichier provisoire ne subsiste.
  assert.deepEqual(win.webContents.executed, [[READY_CODE, true]]);
  assert.deepEqual(readdirSync(path.dirname(file)).sort(), ['etat.json', 'etat.png']);
  assert.doesNotThrow(() => new vm.Script(READY_CODE));
});

test('l’image dessinée par l’application est enregistrée à côté du compte rendu, avant lui', async () => {
  const file = freshFile();
  let statusExistedDuringCapture = null;
  const win = createWindow(() => true, {
    capturePage: () => ({
      toPNG: () => {
        statusExistedDuringCapture = existsSync(file);
        return PNG_BYTES;
      },
    }),
  });
  const status = await reportStatus(win, { file, screen, timings: FAST });

  const capture = path.join(path.dirname(file), 'etat.png');
  assert.equal(status.capture, capture);
  assert.ok(path.isAbsolute(status.capture));
  assert.ok(readFileSync(capture).equals(PNG_BYTES));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).capture, capture);
  assert.equal(win.webContents.captures, 1);
  // Lorsque le compte rendu apparaît, l'image est déjà complète.
  assert.equal(statusExistedDuringCapture, false);
});

test('image impossible à relever : le compte rendu est écrit sans elle, sans blocage', async () => {
  const cases = {
    'capture refusée': () => Promise.reject(new Error('capture impossible')),
    'capture sans réponse': () => new Promise(() => {}),
    'image vide': () => ({ toPNG: () => Buffer.alloc(0) }),
    'conversion impossible': () => ({
      toPNG: () => {
        throw new Error('image invalide');
      },
    }),
  };
  for (const [name, capturePage] of Object.entries(cases)) {
    const started = Date.now();
    const { file, written } = await run(createWindow(() => true, { capturePage }), { ...FAST, response: 30 });
    assert.equal(written.capture, null, name);
    assert.equal(written.ready, true, name);
    assert.equal(written.visible, true, name);
    assert.deepEqual(readdirSync(path.dirname(file)), ['etat.json'], name);
    assert.ok(Date.now() - started < 2000, name);
  }
});

test('le dossier des données de l’application est cité dans le compte rendu', async () => {
  const file = freshFile();
  const userData = path.join(workDir, 'Evolve');
  const status = await reportStatus(createWindow(), { file, screen, userData, timings: FAST });
  assert.equal(status.userData, userData);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).userData, userData);

  const other = await reportStatus(createWindow(), { file: freshFile(), screen, userData: 42, timings: FAST });
  assert.equal(other.userData, null);
});

test('nom de l’image : celui du compte rendu, avec l’extension .png', () => {
  const dir = path.join(workDir, 'dossier.v2');
  assert.equal(captureFileFor(path.join(dir, 'etat.json')), path.join(dir, 'etat.png'));
  assert.equal(captureFileFor(path.join(dir, 'etat')), path.join(dir, 'etat.png'));
  assert.equal(captureFileFor(path.join(dir, 'etat.final.json')), path.join(dir, 'etat.final.png'));
  // Jamais le fichier du compte rendu lui-même.
  assert.equal(captureFileFor(path.join(dir, 'etat.png')), path.join(dir, 'etat.png.png'));
});

test('l’état relevé est celui de la fenêtre (fenêtrée, masquée, réduite…)', async () => {
  const win = createWindow(() => true, {
    visible: false,
    fullScreen: false,
    minimized: true,
    focused: false,
    bounds: { x: 160, y: 90, width: 1600, height: 900 },
  });
  const { written } = await run(win);
  assert.equal(written.ready, true);
  assert.equal(written.visible, false);
  assert.equal(written.fullscreen, false);
  assert.equal(written.minimized, true);
  assert.equal(written.focused, false);
  assert.deepEqual(written.bounds, { x: 160, y: 90, width: 1600, height: 900 });
  assert.deepEqual(screen.requested.at(-1), win.bounds, "l'écran est celui qui contient la fenêtre");
});

test('l’interface démarre après quelques instants : la page est interrogée jusqu’à ce qu’elle soit prête', async () => {
  let calls = 0;
  const win = createWindow(() => (calls += 1) >= 4);
  const { written } = await run(win);
  assert.equal(written.ready, true);
  assert.equal(calls, 4);
});

test('seule la valeur `true` signifie « prête »', async () => {
  for (const value of [false, null, undefined, 1, 'true', {}]) {
    const { written } = await run(createWindow(() => value), { ...FAST, ready: 40 });
    assert.equal(written.ready, false, `valeur ${JSON.stringify(value)}`);
  }
});

test('interface jamais prête : le compte rendu est tout de même écrit, dans le délai', async () => {
  const started = Date.now();
  const { written } = await run(createWindow(() => false), { ...FAST, ready: 60 });
  assert.equal(written.ready, false);
  assert.equal(written.visible, true, 'le reste de l’état est relevé');
  assert.ok(Date.now() - started < 2000);
});

test('page qui ne répond pas ou qui lève une erreur : jamais de blocage', async () => {
  const silent = await run(createWindow(() => new Promise(() => {})), { ...FAST, ready: 80, response: 20 });
  assert.equal(silent.written.ready, false);

  const throwing = await run(
    createWindow(() => {
      throw new Error('page indisponible');
    }),
    { ...FAST, ready: 40 },
  );
  assert.equal(throwing.written.ready, false);
});

test('erreurs de la page consignées (console, chargement, arrêt du rendu)', async () => {
  let calls = 0;
  const win = createWindow((_code, current) => {
    calls += 1;
    if (calls === 1) {
      current.webContents.emit('console-message', { level: 'error', message: 'TypeError: x' });
      current.webContents.emit('console-message', { level: 'warning', message: 'simple avertissement' });
      current.webContents.emit('console-message', {}, 3, 'ancienne forme');
      current.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///absent.html');
      current.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    }
    return calls >= 2;
  });
  const { written } = await run(win);
  assert.deepEqual(written.errors, [
    'console : TypeError: x',
    'console : ancienne forme',
    'échec de chargement (-6 ERR_FILE_NOT_FOUND) : file:///absent.html',
    'processus de rendu interrompu : crashed',
  ]);
});

test('fenêtre fermée pendant l’attente : état « fermée », sans erreur', async () => {
  let calls = 0;
  const win = createWindow((_code, current) => {
    calls += 1;
    if (calls === 2) current.destroyed = true;
    return false;
  });
  win.getBounds = () => {
    throw new Error('fenêtre détruite');
  };
  const { written } = await run(win);
  assert.equal(written.closed, true);
  assert.equal(written.ready, false);
  assert.equal(written.visible, false);
  assert.equal(written.bounds, null);
  assert.equal(written.display, null);
  assert.equal(written.capture, null);
  assert.equal(calls, 2, 'la page n’est plus interrogée une fois la fenêtre fermée');
  assert.equal(win.webContents.captures, 0, 'aucune image demandée à une fenêtre fermée');
});

test('dossier créé au besoin ; écriture impossible : erreur transmise à l’appelant', async () => {
  const nested = path.join(workDir, 'a', 'b', 'c', 'etat.json');
  await reportStatus(createWindow(), { file: nested, screen, timings: FAST });
  assert.ok(existsSync(nested));

  // Un fichier occupe la place du dossier attendu.
  const blocked = path.join(nested, 'impossible', 'etat.json');
  await assert.rejects(reportStatus(createWindow(), { file: blocked, screen, timings: FAST }));
});

test('durées par défaut raisonnables', () => {
  assert.ok(Object.isFrozen(DEFAULT_TIMINGS));
  assert.ok(DEFAULT_TIMINGS.ready >= 30_000 && DEFAULT_TIMINGS.ready <= 120_000);
  assert.ok(DEFAULT_TIMINGS.poll <= 1000);
  assert.ok(DEFAULT_TIMINGS.response < DEFAULT_TIMINGS.ready);
  assert.ok(DEFAULT_TIMINGS.settle >= 500, 'le passage en plein écran a le temps de se terminer');
});
