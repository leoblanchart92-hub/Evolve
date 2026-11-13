/**
 * Auto-test de l'application (src/main/selftest.js), exécuté ici contre une
 * fausse fenêtre : on vérifie qu'il ne conclut à une réussite que lorsque
 * tout est conforme, et qu'il ne reste jamais bloqué.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat as lstatAsync, rename as renameAsync } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';

import { recycle } from './fixtures/recycle-bin.mjs';
import { fromRoot, loadNativeMove } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { runSelfTest, countColors, DEFAULT_TIMINGS, DEFAULT_SCENARIO, MIN_CAPTURE_COLORS, WALLPAPER } = require('../src/main/selftest.js');
const { CHANGED_SETTINGS, EXPECTED_SETTINGS, PLACEMENT_SETTINGS, PLACEMENT_CHECKS, shiftInside } = require('../src/main/selftest-settings.js');
const desktopTest = require('../src/main/selftest-desktop.js');
const documentsTest = require('../src/main/selftest-documents.js');
const explorerTest = require('../src/main/selftest-explorer.js');
const noReplaceTest = require('../src/main/selftest-no-replace.js');
const operationsTest = require('../src/main/selftest-operations.js');
const { SETTINGS, defaultsOf } = require('../src/services/settings-schema.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-selftest-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/**
 * Déplacement sans remplacement remis à l'auto-test, comme le fait l'application : le vrai module
 * natif (native/evolve_fs.c). L'auto-test l'éprouve sur le disque (voir selftest-no-replace.js).
 */
const nativeMove = loadNativeMove();

/** Durées très courtes : les tests ne patientent pas. */
const FAST = { total: 5_000, ready: 80, check: 80, response: 1_000, poll: 5, settle: 0, input: 0, probe: 80 };

let sequence = 0;
const freshDir = () => path.join(workDir, `essai-${(sequence += 1)}`);

/**
 * Fausse capture d'écran, lisible point par point comme celles d'Electron :
 * `tones` couleurs distinctes réparties sur `width` × `height` points.
 */
function fakeImage({ tones = 300, width = 80, height = 45, scaleFactor = 1 } = {}) {
  const bitmap = Buffer.alloc(width * height * 4, 255);
  for (let index = 0; index < width * height; index += 1) {
    const tone = index % tones;
    bitmap[index * 4] = (tone % 16) * 16;
    bitmap[index * 4 + 1] = (Math.floor(tone / 16) % 16) * 16;
    bitmap[index * 4 + 2] = (Math.floor(tone / 256) % 16) * 16;
  }
  return {
    isEmpty: () => false,
    toPNG: () => Buffer.from('fausse image'),
    getScaleFactors: () => [scaleFactor],
    getSize: () => ({ width: width / scaleFactor, height: height / scaleFactor }),
    toBitmap: () => bitmap,
  };
}

/** Intitulé du contrôle portant sur la capture d'écran du bureau. */
const PAINTED = "l'interface est réellement dessinée dans la fenêtre (capture d'écran non unie)";

/** Début de chaque code de page de l'auto-test des opérations : les outils de l'explorateur, puis ceux des opérations. */
const OPERATION_PRELUDE = `(async () => { ${operationsTest.operationTools(explorerTest.PAGE_TOOLS)} `;

/**
 * Copie un fichier, ou un dossier avec tout son contenu, sans rien remplacer :
 * un nom déjà pris est une erreur.
 *
 * `fs.cpSync` n'est pas employé : sous Windows, il décode les chemins dans la
 * page de codes du système au lieu d'UTF-8, et arrête Node sans un message
 * dès qu'un dossier à copier porte un accent (« Photos d'été »).
 */
function copyTree(source, target) {
  if (!statSync(source).isDirectory()) {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    return;
  }
  mkdirSync(target);
  for (const name of readdirSync(source)) copyTree(path.join(source, name), path.join(target, name));
}

/** Vrai pour un geste de l'auto-test des opérations : ni un état attendu, ni une demande directe à l'application. */
const isGesture = (code) => code.startsWith(OPERATION_PRELUDE) && !code.includes('|| observed();') && !code.includes('window.evolve.files');

/**
 * Imite, sur le disque, ce qu'un explorateur conforme fait des gestes de
 * l'auto-test (voir selftest-operations.js). La fausse page répond « oui » à
 * tout, mais l'auto-test relit lui-même le disque après chaque opération :
 * sans cette imitation, aucun de ces contrôles ne pourrait réussir.
 *
 * @param {object} options
 * @param {string} options.bin  fausse Corbeille (voir fixtures/recycle-bin.mjs)
 * @param {(gesture: string, state: object, dialog: string|null) => void} [options.after]  appelée après chaque
 *        geste — par exemple `dialogPress("skip")` —, avec la nature de la fenêtre de dialogue qui était ouverte :
 *        un test y altère le disque pour imiter un explorateur fautif
 * @returns {(code: string) => void}
 */
function simulateExplorer({ bin, after = () => {} }) {
  const { NAMES } = operationsTest;
  /** Dossier affiché, sélection, presse-papiers, fenêtre de dialogue ouverte, texte saisi. */
  const state = { folder: null, selection: [], clipboard: null, dialog: null, typed: '', bin };
  const here = (name) => path.join(state.folder, name);
  const keptName = (name) => `${name.slice(0, name.length - path.extname(name).length)} - Copie${path.extname(name)}`;

  const commands = {
    'new-folder': () => (state.dialog = { kind: 'new-folder' }),
    rename: () => (state.dialog = { kind: 'rename' }),
    delete: () => (state.dialog = { kind: 'trash' }),
    copy: () => (state.clipboard = { mode: 'copy', items: state.selection.map(here) }),
    cut: () => (state.clipboard = { mode: 'cut', items: state.selection.map(here) }),
    paste: () => {
      if (state.clipboard.mode === 'cut') state.dialog = { kind: 'move' };
      else if (state.clipboard.items.some((item) => existsSync(here(path.basename(item))))) state.dialog = { kind: 'collision' };
      else for (const item of state.clipboard.items) copyTree(item, here(path.basename(item)));
    },
  };
  /** Réponses aux fenêtres de dialogue ; une saisie refusée laisse la fenêtre ouverte. */
  const answers = {
    'new-folder': { confirm: () => (state.typed === 'CON' ? 'open' : mkdirSync(here(state.typed))) },
    rename: { confirm: () => (existsSync(here(state.typed)) ? 'open' : renameSync(here(state.selection[0]), here(state.typed))) },
    collision: {
      // « Ignorer » : seuls les éléments dont le nom est libre sont copiés ; « Conserver les deux » : les autres reçoivent un nouveau nom.
      skip: () => state.clipboard.items.filter((item) => !existsSync(here(path.basename(item)))).forEach((item) => copyTree(item, here(path.basename(item)))),
      'keep-both': () => state.clipboard.items.forEach((item) => copyTree(item, existsSync(here(path.basename(item))) ? here(keptName(path.basename(item))) : here(path.basename(item)))),
    },
    move: {
      confirm: () => {
        for (const item of state.clipboard.items) renameSync(item, here(path.basename(item)));
        state.clipboard = null;
      },
    },
    trash: { confirm: () => state.selection.forEach((name) => recycle(state.bin, here(name))) },
    // Windows exécute le script, qui laisse son fichier témoin à côté de lui.
    open: { confirm: () => writeFileSync(path.join(path.dirname(state.dialog.target), NAMES.marker), 'execute\r\n') },
  };
  const gestures = {
    exOpen: ([location]) => {
      if (statSync(location).isDirectory()) state.folder = location;
      else state.dialog = { kind: 'open', target: location };
    },
    exButton: ([label]) => {
      if (label === 'Dossier parent') state.folder = path.dirname(state.folder);
    },
    exSelect: (names) => (state.selection = names),
    exCommand: ([name]) => commands[name](),
    dialogType: ([text]) => (state.typed = text),
    dialogPress: ([action]) => {
      const stays = answers[state.dialog.kind][action]?.() === 'open';
      if (!stays) state.dialog = null;
    },
  };

  return (code) => {
    if (!isGesture(code)) return;
    for (const [, name, args] of code.slice(OPERATION_PRELUDE.length).matchAll(/\b(exOpen|exButton|exSelect|exCommand|dialogType|dialogPress)\(([^)]*)\)/g)) {
      const dialog = state.dialog?.kind ?? null;
      gestures[name](JSON.parse(`[${args}]`));
      after(`${name}(${args})`, state, dialog);
    }
  };
}

let windows = 0;

/** Code de page par lequel l'auto-test du bureau relève, après chaque pression de Tab, l'élément qui détient le clavier. */
const TAB_PROBE = 'window.__evolveStops.indexOf(el)';
/** Nombre d'éléments que Tab parcourt dans la fenêtre imitée par la fausse page. */
const TAB_STOPS = 5;

/**
 * Fausse fenêtre d'application. Les gestes de l'auto-test des opérations y ont
 * leur effet sur le disque (voir `simulateExplorer`) ; le reste dépend de `answer`.
 *
 * Elle reçoit les gestes de la souris et du clavier injectés par l'auto-test
 * du bureau (`sendInputEvent`) et les consigne dans `webContents.inputs`. Comme
 * dans une fenêtre conforme, Tab y passe d'un élément au suivant, en boucle,
 * et Maj + Tab au précédent.
 *
 * @param {(code: string, webContents: EventEmitter) => unknown} [answer]  réponse de la page au code exécuté
 * @param {object} [options]
 * @param {(gesture: string, state: object, dialog: string|null) => void} [options.after]  voir `simulateExplorer`
 * @param {boolean} [options.input]  faux : la fenêtre ne sait pas recevoir de gestes injectés
 */
function createWindow(answer = () => true, { capturePage, after, input = true } = {}) {
  const webContents = new EventEmitter();
  /** Fausse Corbeille de cette fenêtre : celle que l'auto-test examine quand il se croit sous Windows. */
  const recycleBin = path.join(workDir, `corbeille-${(windows += 1)}`);
  mkdirSync(recycleBin);
  const simulate = simulateExplorer({ bin: recycleBin, after });
  webContents.executed = [];
  webContents.inputs = [];
  let stop = 0;
  if (input) {
    webContents.sendInputEvent = (event) => {
      webContents.inputs.push(event);
      const held = event.modifiers ?? [];
      if (event.type === 'keyDown' && event.keyCode === 'Tab' && !held.includes('control')) stop = (stop + (held.includes('shift') ? TAB_STOPS - 1 : 1)) % TAB_STOPS;
    };
  }
  webContents.executeJavaScript = async (code) => {
    webContents.executed.push(code);
    simulate(code);
    const reply = answer(code, webContents);
    // L'élément qui détient le clavier : dans la fenêtre, au rang où les pressions de Tab l'ont mené.
    return reply === true && code.includes(TAB_PROBE) ? { lieu: 'dedans', rang: stop } : reply;
  };
  return {
    webContents,
    recycleBin,
    showCalls: 0,
    show() {
      this.showCalls += 1;
    },
    getContentBounds: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
    capturePage: capturePage ?? (async () => fakeImage()),
  };
}

/**
 * Lance l'auto-test et renvoie son code de sortie et son rapport. Le système
 * visé est fixé (« linux », sauf demande) : le nombre de contrôles ne dépend
 * pas de la machine qui exécute les tests.
 */
async function run(win, timings = FAST, options = {}) {
  const outDir = options.outDir ?? freshDir();
  // Sous Windows, l'auto-test examine la Corbeille : ici, celle de la fausse fenêtre.
  const recycleBin = Object.hasOwn(options, 'recycleBin') ? options.recycleBin : options.platform === 'win32' ? win.recycleBin : undefined;
  // Le déplacement sans remplacement est le vrai ; une seule course de chaque sorte, pour que les tests restent brefs.
  const code = await runSelfTest(win, { timings, platform: 'linux', moveNoReplace: nativeMove, noReplaceRounds: 1, ...options, recycleBin, outDir });
  const report = JSON.parse(readFileSync(path.join(outDir, 'result.json'), 'utf8'));
  return { code, report, outDir };
}

/**
 * Nombre de contrôles du scénario complet, quand la page reçoit les gestes de
 * la souris et du clavier. Dix d'entre eux en dépendent : sans eux, ils ne
 * sont pas menés (voir selftest-desktop.js).
 */
const FULL_CHECKS = 73;
/** Sous Windows, trois de plus : dossier protégé, contenu de la Corbeille, script réellement exécuté. */
const WINDOWS_CHECKS = FULL_CHECKS + 3;

/** Captures d'écran du scénario complet. */
const CAPTURES = [
  '01-bureau.png',
  '02-menu-demarrer.png',
  '03-recherche.png',
  '04-parametres-rapides.png',
  '05-notifications.png',
  '06-explorateur.png',
  '07-nom-deja-pris.png',
  '08-corbeille.png',
  '09-fenetres.png',
  '10-bascule-fenetres.png',
];

const failed = (report) => report.checks.filter((item) => !item.ok).map((item) => item.name);

test('tout est conforme : code 0, rapport complet, dix captures', async () => {
  const win = createWindow();
  const { code, report, outDir } = await run(win);

  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.equal(report.scenario, 'full');
  assert.equal(DEFAULT_SCENARIO, 'full');
  assert.equal(report.services, null, "sans état des services fourni, le rapport n'en invente pas");
  assert.equal(report.checks.length, FULL_CHECKS);
  assert.equal(report.explorer, null, "sans réponse du service de fichiers, le rapport n'invente aucun emplacement");
  assert.equal(report.recycled, null, 'hors de Windows, la Corbeille n’est pas examinée');
  assert.equal(noReplaceTest.summarizeFacts(report.noReplace)?.startsWith('Sans remplacement : '), true, 'constats de la vérification « rien n’est remplacé »');
  assert.deepEqual(failed(report), []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.window, { width: 1600, height: 900 });
  assert.equal(report.versions.node, process.versions.node);
  assert.equal(report.executable, process.execPath);
  assert.ok(report.durationMs >= 0);
  assert.equal(new Set(report.checks.map((item) => item.name)).size, FULL_CHECKS, 'intitulés tous différents');

  assert.deepEqual(report.captures, CAPTURES);
  // À côté du rapport et des captures : les dossiers d'essai de l'explorateur.
  assert.deepEqual(readdirSync(outDir).sort(), [...report.captures, explorerTest.FIXTURE_DIR, 'result.json'].sort());
  assert.deepEqual(
    report.images,
    report.captures.map((file) => ({ file, width: 80, height: 45, colors: 300 })),
  );
  assert.equal(win.showCalls, 1, 'la fenêtre est affichée pour le test');
});

test('le code exécuté dans la page est du JavaScript valide', async () => {
  // Les deux variantes du scénario : celle de Windows comporte un contrôle de plus.
  for (const platform of ['linux', 'win32']) {
    const win = createWindow();
    await run(win, FAST, { platform });
    assert.ok(win.webContents.executed.length >= 60, platform);
    for (const code of win.webContents.executed) {
      assert.doesNotThrow(() => new vm.Script(code), `code invalide : ${code.slice(0, 120)}…`);
      assert.match(code, /^\(async \(\) => \{[\s\S]*\}\)\(\)$/);
    }
  }
});

test('le fond d’écran embarqué est comparé à l’empreinte de l’image fournie', async () => {
  assert.equal(WALLPAPER.file, fromRoot('assets', 'wallpapers', 'panorama-cosmique-violet-sur-lac-miroir.png'));
  assert.equal(createHash('sha256').update(readFileSync(WALLPAPER.file)).digest('hex'), WALLPAPER.sha256);
  assert.deepEqual([WALLPAPER.width, WALLPAPER.height], [1672, 941]);

  const { report } = await run(createWindow());
  const check = report.checks.find((item) => /empreinte SHA-256/.test(item.name));
  assert.deepEqual(check, { name: "fond d'écran embarqué identique à l'image fournie (empreinte SHA-256)", ok: true });
});

test('un contrôle en échec : code 1, valeur observée consignée, les autres contrôles continuent', async () => {
  const observed = { complete: true, width: 800, height: 450 };
  const win = createWindow((code) => (code.includes('naturalWidth') ? observed : true));
  const { code, report } = await run(win);

  assert.equal(code, 1);
  assert.equal(report.ok, false);
  assert.equal(report.checks.length, FULL_CHECKS);
  assert.deepEqual(failed(report), ["fond d'écran officiel affiché sans déformation ni filtre"]);
  assert.deepEqual(report.checks.find((item) => !item.ok).value, observed);
  assert.equal(report.captures.length, CAPTURES.length);
});

test('seule la valeur `true` est une réussite', async () => {
  for (const value of [false, null, undefined, 1, 'true', {}, []]) {
    // Le contrôle des icônes du bureau est le seul à compter celles que Tab atteint.
    const win = createWindow((code) => (code.includes('icon.tabIndex === 0') ? value : true));
    const { code, report } = await run(win);
    assert.equal(code, 1, `valeur ${JSON.stringify(value)}`);
    assert.deepEqual(failed(report), ['icônes du bureau, chaque nom sur une seule ligne']);
  }
});

test('un contrôle réussit dès que l’état attendu apparaît (animations, machine lente)', async () => {
  let attempts = 0;
  const win = createWindow((code) => (code.includes("classList.contains('is-ready')") ? (attempts += 1) >= 4 : true));
  const { code, report } = await run(win, { ...FAST, ready: 2_000 });
  assert.equal(code, 0);
  assert.equal(attempts, 4);
  assert.equal(report.ok, true);
});

test("l'interface ne démarre pas : échec immédiat, sans contrôle ni capture supplémentaire", async () => {
  const win = createWindow(() => false);
  const { code, report } = await run(win);

  assert.equal(code, 1);
  assert.deepEqual(report.checks, [{ name: "l'interface a démarré", ok: false, value: false }]);
  assert.deepEqual(report.captures, []);
  assert.equal(report.window, null);
  assert.ok(win.webContents.executed.every((item) => item.includes('is-ready')));
});

test('une erreur dans la console de la page fait échouer le test', async () => {
  let emitted = false;
  const win = createWindow((_code, webContents) => {
    if (!emitted) {
      emitted = true;
      webContents.emit('console-message', { level: 'error', message: 'Refused to load the script' });
      webContents.emit('console-message', { level: 'warning', message: 'simple avertissement' });
      webContents.emit('console-message', { level: 'info', message: 'information' });
    }
    return true;
  });
  const { code, report } = await run(win);

  assert.equal(code, 1);
  assert.deepEqual(failed(report), [], 'tous les contrôles passent, mais…');
  assert.deepEqual(report.errors, ['console : Refused to load the script']);
  assert.deepEqual(report.warnings, ['simple avertissement']);
});

test('un avertissement seul ne fait pas échouer le test', async () => {
  let emitted = false;
  const win = createWindow((_code, webContents) => {
    if (!emitted) {
      emitted = true;
      webContents.emit('console-message', { level: 'warning', message: 'simple avertissement' });
    }
    return true;
  });
  const { code, report } = await run(win);
  assert.equal(code, 0);
  assert.deepEqual(report.warnings, ['simple avertissement']);
});

test('ancienne forme de l’événement de console (niveau numérique) reconnue', async () => {
  let emitted = false;
  const win = createWindow((_code, webContents) => {
    if (!emitted) {
      emitted = true;
      webContents.emit('console-message', {}, 3, 'erreur ancienne forme');
      webContents.emit('console-message', {}, 2, 'avertissement ancienne forme');
      webContents.emit('console-message', {}, 1, 'information');
    }
    return true;
  });
  const { code, report } = await run(win);
  assert.equal(code, 1);
  assert.deepEqual(report.errors, ['console : erreur ancienne forme']);
  assert.deepEqual(report.warnings, ['avertissement ancienne forme']);
});

test('échec de chargement : erreur consignée, aucune attente inutile', async () => {
  let emitted = false;
  const win = createWindow((_code, webContents) => {
    if (!emitted) {
      emitted = true;
      webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///absent/index.html');
    }
    return false;
  });
  const startedAt = Date.now();
  // Délais de production : sans arrêt anticipé, ce test durerait 45 secondes.
  const { code, report } = await run(win, { settle: 0 });

  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt < 3_000, 'le test renonce dès l’erreur fatale');
  assert.deepEqual(report.errors, ['échec de chargement (-6 ERR_FILE_NOT_FOUND) : file:///absent/index.html']);
  assert.equal(report.checks.length, 1);
});

test('arrêt du moteur de rendu ou erreur du script de préchargement : échec', async () => {
  const scenarios = [
    ['render-process-gone', [{}, { reason: 'crashed' }], /processus de rendu interrompu : crashed/],
    ['preload-error', [{}, 'preload.js', new Error('module introuvable')], /erreur du script de préchargement preload\.js : module introuvable/],
  ];
  for (const [event, args, expected] of scenarios) {
    let emitted = false;
    const win = createWindow((code, webContents) => {
      // Émis après le démarrage, au milieu du scénario.
      if (!emitted && code.includes('.desktop-icon')) {
        emitted = true;
        webContents.emit(event, ...args);
      }
      return true;
    });
    const { code, report } = await run(win);
    assert.equal(code, 1, event);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], expected);
  }
});

test('une action impossible dans la page est une erreur', async () => {
  const win = createWindow((code) => {
    if (code.includes(".tb-tray').click()")) throw new TypeError("Cannot read properties of null (reading 'click')");
    return true;
  });
  const { code, report } = await run(win);
  assert.equal(code, 1);
  assert.deepEqual(report.errors, ["action impossible : Cannot read properties of null (reading 'click')"]);
});

test('une exception pendant un contrôle est consignée comme valeur observée', async () => {
  const win = createWindow((code) => {
    if (code.includes('.cal__day')) throw new Error('élément absent');
    return true;
  });
  const { code, report } = await run(win);
  assert.equal(code, 1);
  assert.deepEqual(failed(report), ["le centre de notifications s'ouvre avec son calendrier"]);
  assert.equal(report.checks.find((item) => !item.ok).value, 'exception : élément absent');
});

test('comptage des couleurs d’une image', () => {
  const pixels = (...colors) => Buffer.from(colors.flatMap(([r, g, b]) => [r, g, b, 255]));
  assert.equal(countColors(Buffer.alloc(0)), 0);
  assert.equal(countColors(Buffer.alloc(3)), 0, 'moins d’un point');
  assert.equal(countColors(Buffer.alloc(4 * 1000, 7)), 1, 'aplat uni');
  assert.equal(countColors(pixels([0, 0, 0], [255, 255, 255], [0, 0, 0])), 2);
  assert.equal(countColors(pixels([16, 0, 0], [0, 16, 0], [0, 0, 16])), 3, 'les trois composantes comptent');
  assert.equal(countColors(pixels([32, 32, 32], [47, 40, 33])), 1, 'nuances très proches confondues');
  assert.equal(countColors(Buffer.from([9, 9, 9, 0, 9, 9, 9, 255])), 1, 'la transparence est ignorée');

  // Grande image : l'échantillon couvre toute la surface (ici, deux moitiés).
  const large = Buffer.alloc(1600 * 900 * 4, 0);
  large.fill(255, large.length / 2);
  assert.equal(countColors(large), 2);
  // Largeur paire : l'échantillon ne se limite pas à quelques colonnes.
  const stripes = Buffer.alloc(1024 * 512 * 4, 0);
  for (let index = 0; index < 1024 * 512; index += 1) stripes[index * 4] = (index % 1024) >> 2;
  assert.ok(countColors(stripes) >= 16);

  assert.equal(countColors(fakeImage({ tones: 300 }).toBitmap()), 300);
  assert.equal(countColors(fakeImage({ tones: 1 }).toBitmap()), 1);
});

test('fenêtre restée vide (capture du bureau unie) : échec', async () => {
  const blank = createWindow(() => true, { capturePage: async () => fakeImage({ tones: 1 }) });
  const { code, report } = await run(blank);
  assert.equal(code, 1);
  assert.deepEqual(failed(report), [PAINTED]);
  assert.deepEqual(report.checks.find((item) => !item.ok).value, { file: '01-bureau.png', width: 80, height: 45, colors: 1 });
  assert.equal(report.captures.length, CAPTURES.length, 'les captures sont tout de même enregistrées');

  // Seuil : en dessous, la capture est considérée comme vide.
  const below = await run(createWindow(() => true, { capturePage: async () => fakeImage({ tones: MIN_CAPTURE_COLORS - 1 }) }));
  assert.equal(below.code, 1);
  assert.deepEqual(failed(below.report), [PAINTED]);
  const enough = await run(createWindow(() => true, { capturePage: async () => fakeImage({ tones: MIN_CAPTURE_COLORS }) }));
  assert.equal(enough.code, 0);
  assert.ok(MIN_CAPTURE_COLORS >= 16 && MIN_CAPTURE_COLORS <= 100, 'seuil entre un aplat (1) et une vraie capture (plus de 200)');
});

test('seule la capture du bureau est jugée ; les dimensions tiennent compte de l’échelle de l’écran', async () => {
  let calls = 0;
  const win = createWindow(() => true, {
    // Première capture (bureau) riche en couleurs sur un écran à 200 %, les suivantes unies.
    capturePage: async () => ((calls += 1) === 1 ? fakeImage({ scaleFactor: 2 }) : fakeImage({ tones: 1 })),
  });
  const { code, report } = await run(win);
  assert.equal(code, 0);
  assert.equal(report.checks.filter((item) => item.name === PAINTED).length, 1);
  assert.deepEqual(report.images[0], { file: '01-bureau.png', width: 80, height: 45, colors: 300 });
  assert.deepEqual(report.images[1], { file: '02-menu-demarrer.png', width: 80, height: 45, colors: 1 });
});

test('capture non mesurable : le contrôle correspondant est simplement omis', async () => {
  const basic = () => ({ isEmpty: () => false, toPNG: () => Buffer.from('image') });
  const images = [
    basic(),
    { ...fakeImage(), toBitmap: () => Buffer.alloc(0) },
    {
      ...fakeImage(),
      toBitmap: () => {
        throw new Error('lecture impossible');
      },
    },
  ];
  for (const image of images) {
    const { code, report } = await run(createWindow(() => true, { capturePage: async () => image }));
    assert.equal(code, 0);
    assert.equal(report.checks.length, FULL_CHECKS - 1);
    assert.ok(!report.checks.some((item) => item.name === PAINTED));
    assert.deepEqual(report.images, []);
    assert.equal(report.captures.length, CAPTURES.length);
    assert.deepEqual(report.warnings, []);
  }
});

test('captures impossibles ou vides : simples avertissements, le test reste valable', async () => {
  const failing = createWindow(() => true, { capturePage: async () => Promise.reject(new Error('fenêtre masquée')) });
  const first = await run(failing);
  assert.equal(first.code, 0);
  assert.equal(first.report.checks.length, FULL_CHECKS - 1);
  assert.deepEqual(first.report.captures, []);
  assert.equal(first.report.warnings.length, CAPTURES.length);
  assert.match(first.report.warnings[0], /capture « 01-bureau » impossible : fenêtre masquée/);

  const empty = createWindow(() => true, { capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) });
  const second = await run(empty);
  assert.equal(second.code, 0);
  assert.deepEqual(second.report.captures, []);
  assert.match(second.report.warnings[0], /capture « 01-bureau » vide/);
  assert.deepEqual(readdirSync(second.outDir).sort(), [explorerTest.FIXTURE_DIR, 'result.json']);

  const hanging = createWindow(() => true, { capturePage: () => new Promise(() => {}) });
  const third = await run(hanging, { ...FAST, response: 20 });
  assert.equal(third.code, 0);
  assert.match(third.report.warnings[0], /capture « 01-bureau » impossible : aucune image en 0\.02 s/);
});

test('page qui ne répond pas : échec dans le délai imparti, jamais de blocage', async () => {
  const win = createWindow(() => new Promise(() => {}));
  const { code, report } = await run(win, { ...FAST, response: 20, ready: 60 });
  assert.equal(code, 1);
  assert.deepEqual(report.checks, [
    { name: "l'interface a démarré", ok: false, value: 'exception : aucune réponse de la page en 0.02 s' },
  ]);
});

test('durée maximale dépassée : le rapport est tout de même écrit, en échec', async () => {
  const win = createWindow(() => new Promise(() => {}));
  // La page ne répond jamais et la durée totale expire avant tout autre délai.
  const { code, report } = await run(win, { ...FAST, total: 60, response: 400, ready: 400 });
  assert.equal(code, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, ['délai dépassé (0.06 s)']);
});

test('rapport impossible à écrire : échec', async () => {
  const blocker = path.join(workDir, 'fichier');
  writeFileSync(blocker, 'pas un dossier');
  await assert.rejects(runSelfTest(createWindow(), { outDir: path.join(blocker, 'resultats'), timings: FAST }));
  assert.equal(existsSync(path.join(blocker, 'resultats')), false);
});

test('les durées de production laissent le temps à une machine lente', () => {
  assert.ok(DEFAULT_TIMINGS.ready >= 30_000);
  assert.ok(DEFAULT_TIMINGS.check >= 10_000);
  assert.ok(DEFAULT_TIMINGS.total >= 120_000 && DEFAULT_TIMINGS.total <= 240_000, 'inférieure au délai de scripts/check-exe.mjs (300 s)');
  assert.ok(Object.isFrozen(DEFAULT_TIMINGS));
});

// ---------------------------------------------------------------------------------
// Explorateur de fichiers : vrais dossiers, consultation
// ---------------------------------------------------------------------------------

/** Intitulés des contrôles des opérations sur les fichiers (voir la section qui leur est consacrée, plus bas). */
const OPERATIONS = operationsTest.CHECKS;
const READ_ONLY_CHECK =
  "le service de consultation n'offre aucune opération d'écriture : chaque opération passe par une fonction distincte, sans suppression définitive ni remplacement";
const UNCHANGED_CHECK = "parcourir un dossier n'y modifie rien : le dossier seulement consulté est resté identique (contenu, tailles et dates)";
const NO_REPLACE_CHECK = noReplaceTest.CHECK;

/** Intitulés des contrôles de l'explorateur, dans l'ordre du scénario. */
const EXPLORER_CHECKS = [
  "l'explorateur présente les vrais dossiers, sans contenu d'exemple ; à l'accueil, aucune opération sur les fichiers n'est proposée",
  '« Ce PC » présente les dossiers personnels et les lecteurs de cet ordinateur',
  "chaque dossier personnel disponible s'ouvre (Bureau, Documents, Téléchargements, Images, Musique, Vidéos)",
  null, // navigation au double-clic : l'intitulé cite le nombre de niveaux
  "le dossier d'essai affiche son contenu réel (noms avec espaces, accents et apostrophe)",
  'un dossier supprimé entre-temps affiche « Dossier introuvable », sans bloquer la navigation',
  'les éléments masqués ne sont affichés que sur demande (menu Affichage)',
  'vue « Détails » : type, taille et date de modification réels',
  "un sous-dossier s'ouvre au double-clic",
  '« Précédent » revient au dossier quitté',
  '« Suivant » retourne dans le sous-dossier',
  '« Dossier parent » remonte d’un niveau',
  'un dossier vide est annoncé comme tel',
  'la recherche filtre le dossier affiché, sans tenir compte de la casse ni des accents',
  '« Actualiser » fait apparaître un fichier ajouté entre-temps',
  // Opérations menées dans l'interface, chacune contrôlée sur le disque.
  OPERATIONS.create,
  OPERATIONS.collision,
  OPERATIONS.rename,
  OPERATIONS.move,
  OPERATIONS.copy,
  OPERATIONS.trash,
  OPERATIONS.open,
  '« Réseau » et « Corbeille » sont annoncés comme non disponibles, sans contenu fictif',
  'le service de fichiers refuse les chemins relatifs, réseau ou spéciaux, et distingue dossier introuvable et fichier',
  READ_ONLY_CHECK,
  // Demandes refusées ; déplacement sans remplacement éprouvé sur le disque ; état final des deux dossiers d'essai.
  OPERATIONS.unconfirmed,
  OPERATIONS.refused,
  NO_REPLACE_CHECK,
  UNCHANGED_CHECK,
  OPERATIONS.state,
];
const PROTECTED_CHECK = 'un dossier protégé de Windows affiche « Accès refusé », sans bloquer la navigation';

/**
 * Dossier d'essai créé par l'auto-test dans son dossier de sortie, désigné
 * comme l'auto-test le désigne : par son chemin réel (noms longs sous Windows).
 */
function fixtureOf(outDir) {
  const base = path.join(outDir, explorerTest.FIXTURE_DIR);
  const runs = readdirSync(base);
  assert.equal(runs.length, 1, 'un seul dossier d’essai par exécution');
  assert.match(runs[0], /^essai-\w{6}$/);
  return path.join(realpathSync.native(path.join(base, runs[0])), explorerTest.FOLDER_NAME);
}

test('explorateur : les contrôles se suivent dans l’ordre, entre l’ouverture de la fenêtre et son agrandissement', async () => {
  const { report } = await run(createWindow());
  const names = report.checks.map((item) => item.name);
  const start = names.indexOf("l'explorateur de fichiers s'ouvre dans une fenêtre") + 1;
  const found = names.slice(start, start + EXPLORER_CHECKS.length);
  assert.match(found[3], /^navigation au double-clic, de « Ce PC » jusqu'au dossier d'essai \(\d+ niveaux\)$/);
  assert.deepEqual(found.map((name, index) => (index === 3 ? null : name)), EXPLORER_CHECKS);
  assert.equal(names[start + EXPLORER_CHECKS.length], "la fenêtre s'agrandit sur tout l'espace de travail");
  // La capture de l'explorateur est prise dans le dossier d'essai, en vue « Détails ».
  assert.equal(report.captures[5], '06-explorateur.png');
});

test('explorateur : un dossier d’essai réel est créé dans le dossier de sortie, puis laissé sur place', async () => {
  const { DETAILED_FILE, VISIBLE_NAMES, ADDED_NAME, FOLDER_NAME } = explorerTest;
  for (const [platform, hidden, absent] of [['linux', '.masque', 'Thumbs.db'], ['win32', 'Thumbs.db', '.masque']]) {
    const { code, outDir } = await run(createWindow(), FAST, { platform });
    assert.equal(code, 0);
    const folder = fixtureOf(outDir);
    // Nom avec espaces, accents et apostrophe ; un élément masqué, selon le système.
    assert.equal(FOLDER_NAME, "Dossier d'essai été 2026");
    assert.deepEqual(readdirSync(folder).sort(), [...VISIBLE_NAMES, ADDED_NAME, hidden].sort(), platform);
    assert.equal(existsSync(path.join(folder, absent)), false);
    assert.deepEqual(readdirSync(path.join(folder, 'Photos de vacances')), ['plage.jpg']);
    assert.deepEqual(readdirSync(path.join(folder, 'Sous-dossier vide')), []);

    // Fichier témoin de la vue « Détails » : taille et date connues à l'avance.
    const info = statSync(path.join(folder, DETAILED_FILE.name));
    assert.equal(info.size, DETAILED_FILE.bytes);
    assert.equal(Math.round(info.mtimeMs), DETAILED_FILE.modified.getTime());
    assert.deepEqual([DETAILED_FILE.size, DETAILED_FILE.date, DETAILED_FILE.type], ['1,5 Ko', '14/03/2026 15:09', 'Document texte']);
  }
});

test('explorateur : un dossier est retiré pendant que l’explorateur l’affiche encore, pour éprouver « Dossier introuvable »', async () => {
  const { REMOVED_NAME } = explorerTest;
  const outDir = freshDir();
  const seen = {};
  const win = createWindow((code) => {
    const present = () => existsSync(path.join(fixtureOf(outDir), REMOVED_NAME));
    // Contenu du dossier d'essai : le dossier y figure encore, sur le disque comme à l'écran.
    if (code.includes('is-dimmed') && seen.listed === undefined) seen.listed = present() && code.includes(REMOVED_NAME);
    // Ouverture du dossier : il a été retiré juste avant, par l'auto-test lui-même.
    if (code.includes("state.code === 'not-found'") && seen.opened === undefined) seen.opened = present();
    return true;
  });
  const { code, report } = await run(win, FAST, { outDir });
  assert.equal(code, 0);
  assert.deepEqual(seen, { listed: true, opened: false });
  assert.equal(existsSync(path.join(fixtureOf(outDir), REMOVED_NAME)), false);

  // Aller par un double-clic sur le dossier disparu, retour par « Précédent ».
  const script = win.webContents.executed.find((item) => item.includes("state.code === 'not-found'"));
  assert.ok(script.includes(`exOpen(${JSON.stringify(path.join(fixtureOf(outDir), REMOVED_NAME))})`));
  assert.match(script, /state\.message === 'Dossier introuvable'/);
  assert.match(script, /exButton\('Précédent'\)\.click\(\)/);

  // La page d'erreur n'apparaît pas : le contrôle échoue, seul.
  const stuck = createWindow((item) => (item.includes("state.code === 'not-found'") ? { page: 'folder', code: '' } : true));
  const failing = await run(stuck);
  assert.equal(failing.code, 1);
  assert.deepEqual(failed(failing.report), [EXPLORER_CHECKS[5]]);
  assert.deepEqual(failing.report.checks.find((item) => !item.ok).value, { page: 'folder', code: '' });
});

test('explorateur : le trajet jusqu’au dossier d’essai se fait au double-clic, un niveau après l’autre', async () => {
  const win = createWindow();
  const { outDir } = await run(win);
  const folder = fixtureOf(outDir);
  const steps = explorerTest.stepsTo(folder);
  assert.ok(steps.length >= 4);
  assert.equal(steps.at(-1).path, folder);
  assert.match(steps[0].id, /^drive:/);

  // Chaque niveau : un double-clic sur l'élément, puis l'attente du dossier affiché.
  const { executed } = win.webContents;
  let position = -1;
  for (const step of steps) {
    const index = executed.findIndex((code, at) => at > position && code.includes(`exOpen(${JSON.stringify(step.id)})`) && code.includes(`dataset.path === ${JSON.stringify(step.path)}`));
    assert.ok(index > position, `étape absente ou hors d'ordre : ${step.id}`);
    position = index;
  }
  assert.ok(executed.some((code) => code.includes("new MouseEvent('dblclick', { bubbles: true })")));
  // Le service n'est appelé directement que pour constater ses refus — jamais pour naviguer.
  const direct = executed.filter((code) => /files\('list'|'files', 'list'/.test(code));
  assert.ok(direct.length >= 2);
  for (const code of direct) assert.match(code, /refused|wrong|accepted/);
});

test('trajet vers un dossier : lecteur puis dossiers, sous Windows comme ailleurs', () => {
  assert.deepEqual(explorerTest.stepsTo("D:\\a\\Evolve\\Dossier d'essai"), [
    { id: 'drive:D:', path: 'D:\\' },
    { id: 'D:\\a', path: 'D:\\a' },
    { id: 'D:\\a\\Evolve', path: 'D:\\a\\Evolve' },
    { id: "D:\\a\\Evolve\\Dossier d'essai", path: "D:\\a\\Evolve\\Dossier d'essai" },
  ]);
  assert.deepEqual(explorerTest.stepsTo('C:\\'), [{ id: 'drive:C:', path: 'C:\\' }]);
  assert.deepEqual(explorerTest.stepsTo('/tmp/essai'), [
    { id: 'drive:/', path: '/' },
    { id: '/tmp', path: '/tmp' },
    { id: '/tmp/essai', path: '/tmp/essai' },
  ]);
});

test('explorateur : la moindre modification du dossier parcouru fait échouer l’auto-test', async () => {
  const { DETAILED_FILE } = explorerTest;
  const changes = {
    'contenu modifié, taille identique': (folder) => writeFileSync(path.join(folder, DETAILED_FILE.name), Buffer.alloc(DETAILED_FILE.bytes, 9)),
    'fichier allongé': (folder) => appendFileSync(path.join(folder, 'Budget 2026.xlsx'), 'x'),
    'fichier supprimé': (folder) => rmSync(path.join(folder, 'Photos de vacances', 'plage.jpg')),
    'fichier créé': (folder) => writeFileSync(path.join(folder, 'Sous-dossier vide', 'intrus.txt'), ''),
    'dossier créé': (folder) => mkdirSync(path.join(folder, 'Nouveau dossier')),
    'date modifiée seule': (folder) => utimesSync(path.join(folder, 'Résumé été.pdf'), new Date(2020, 0, 1), new Date(2020, 0, 1)),
  };
  // Avant le retrait du dossier témoin, avant l'ajout du fichier témoin, et après : tout le scénario est surveillé.
  for (const moment of ['is-dimmed', 'Ce dossier est vide', 'Corbeille non disponible']) {
    for (const [label, change] of Object.entries(changes)) {
      const outDir = freshDir();
      let done = false;
      const win = createWindow((code) => {
        if (!done && code.includes(moment)) {
          done = true;
          change(fixtureOf(outDir));
        }
        return true;
      });
      const { code, report } = await run(win, FAST, { outDir });
      assert.equal(done, true);
      assert.equal(code, 1, `${label} (${moment})`);
      assert.deepEqual(failed(report), [UNCHANGED_CHECK], `${label} (${moment})`);
    }
  }
});

/** Ce que l'application annonce de ses opérations sur les fichiers (voir src/services/index.js). */
const SOUND_OPERATIONS = Object.freeze({
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

test('explorateur : un service de consultation qui sait écrire fait échouer l’auto-test', async () => {
  const described = (methods, operations = SOUND_OPERATIONS) => () => ({
    settings: {},
    files: { state: 'available', access: 'read-only', methods, events: [] },
    ...(operations ? { 'file-operations': operations } : {}),
  });

  const sound = await run(createWindow(), FAST, { describeServices: described(['places', 'list']) });
  assert.equal(sound.code, 0);
  // Ce que l'application réelle annonce satisfait le contrôle (à la Corbeille, à l'ouverture et au déplacement sans
  // remplacement près, fournis par Windows).
  const { createServices } = require('../src/services/index.js');
  assert.deepEqual(createServices({ operations: { trash: async () => {}, openPath: async () => '', moveNoReplace: nativeMove } }).describe()['file-operations'], SOUND_OPERATIONS);
  // Sans déplacement sans remplacement, elle l'annonce : l'auto-test échoue (voir plus bas).
  assert.equal(createServices({ operations: { trash: async () => {}, openPath: async () => '' } }).describe()['file-operations'].noReplaceMove, false);

  // Méthode supplémentaire annoncée par le service.
  for (const methods of [['places', 'list', 'write'], ['list', 'places'], ['places'], [], undefined]) {
    const { code, report } = await run(createWindow(), FAST, { describeServices: described(methods) });
    assert.equal(code, 1, JSON.stringify(methods));
    assert.deepEqual(failed(report), [READ_ONLY_CHECK]);
    assert.deepEqual(report.checks.find((item) => !item.ok).value, { methodes: methods ?? [], operations: SOUND_OPERATIONS, demandes: true });
  }

  // Opérations annoncées autrement : une fonction de plus, une suppression définitive, un remplacement possible,
  // pas de Corbeille, d'ouverture ou de déplacement sans remplacement fournis par Windows, ou aucune annonce.
  const unsound = [
    { ...SOUND_OPERATIONS, methods: [...SOUND_OPERATIONS.methods, 'delete'] },
    { ...SOUND_OPERATIONS, methods: ['createFolder', 'rename', 'copy', 'move', 'trash'] },
    { ...SOUND_OPERATIONS, deletion: 'permanent' },
    { ...SOUND_OPERATIONS, replace: 'ask' },
    { ...SOUND_OPERATIONS, trash: false },
    { ...SOUND_OPERATIONS, open: false },
    { ...SOUND_OPERATIONS, noReplaceMove: false },
    { ...SOUND_OPERATIONS, noReplaceMove: undefined },
    { ...SOUND_OPERATIONS, noReplaceMove: 'oui' },
    { ...SOUND_OPERATIONS, methods: undefined },
    null,
  ];
  for (const operations of unsound) {
    const { code, report } = await run(createWindow(), FAST, { describeServices: described(['places', 'list'], operations) });
    assert.equal(code, 1, JSON.stringify(operations));
    assert.deepEqual(failed(report), [READ_ONLY_CHECK]);
    assert.deepEqual(report.checks.find((item) => !item.ok).value, { methodes: ['places', 'list'], operations: JSON.parse(JSON.stringify(operations ?? {})), demandes: true });
  }

  // Demande d'écriture acceptée par la page.
  const accepted = [{ method: 'delete', obtenu: 'accepté' }];
  const win = createWindow((code) => (code.includes("code !== 'unknown-method'") ? accepted : true));
  const { code, report } = await run(win, FAST, { describeServices: described(['places', 'list']) });
  assert.equal(code, 1);
  assert.deepEqual(failed(report), [READ_ONLY_CHECK]);
  assert.deepEqual(report.checks.find((item) => !item.ok).value, { methodes: ['places', 'list'], operations: SOUND_OPERATIONS, demandes: accepted });

  // Chaque opération d'écriture, de suppression ou d'ouverture est tentée depuis la page.
  const attempts = win.webContents.executed.find((script) => script.includes("code !== 'unknown-method'"));
  for (const method of ['write', 'create', 'mkdir', 'rename', 'move', 'copy', 'delete', 'remove', 'trash', 'open', 'read']) {
    assert.ok(attempts.includes(`"${method}"`), method);
  }
  assert.deepEqual([...explorerTest.WRITE_METHODS].sort(), ['copy', 'create', 'delete', 'mkdir', 'move', 'open', 'read', 'remove', 'rename', 'trash', 'write']);
});

test('déplacement sans remplacement : l’auto-test éprouve sur le disque la fonction que l’application emploie, dans un dossier à lui', async () => {
  const { code, report, outDir } = await run(createWindow(), FAST, { noReplaceRounds: undefined });
  assert.equal(code, 0);
  assert.deepEqual(failed(report), []);

  // Les constats sont joints au rapport : refus du système devant un nom pris, courses, aucune perte.
  const facts = report.noReplace;
  // Sans le cas du chemin de plus de 260 caractères : le dossier d'essai est conservé, puis archivé avec le rapport.
  assert.deepEqual([facts.free, facts.longPath], [4, false]);
  assert.equal(facts.taken.cases, facts.link ? 8 : 6);
  assert.equal(facts.caseOnly, 2);
  // Par défaut : dix courses entre fichiers, dix entre dossiers, et autant entre un déplacement et une création.
  assert.deepEqual([facts.races.rounds, facts.contests.rounds, facts.races.lost], [40, 20, 0]);
  assert.equal(facts.crossVolume, null, 'un seul lecteur : celui du dossier de sortie');
  assert.match(noReplaceTest.summarizeFacts(facts), /^Sans remplacement : \d déplacements vers un nom déjà pris refusés par le système \(code \d+\) · 40 courses, 160 demandes simultanées, aucun élément remplacé ni perdu$/);

  // Le dossier d'essai de ce contrôle est créé à côté du dossier parcouru et de l'atelier, puis laissé sur place.
  const run1 = path.dirname(fixtureOf(outDir));
  assert.deepEqual(readdirSync(run1).sort(), [explorerTest.FOLDER_NAME, operationsTest.WORKSHOP_NAME, noReplaceTest.FOLDER_NAME].sort());
  const kept = path.join(run1, noReplaceTest.FOLDER_NAME);
  assert.deepEqual(readdirSync(kept).sort(), ['1 - nom libre', '2 - nom déjà pris', '3 - casse', '4 - concurrence']);
  // Aucun chemin n'y dépasse la limite historique de Windows : le dossier peut être archivé et extrait par tout outil.
  const longest = (folder) => readdirSync(folder, { withFileTypes: true }).reduce((most, item) => Math.max(most, item.isDirectory() && !item.isSymbolicLink() ? longest(path.join(folder, item.name)) : path.join(folder, item.name).length), folder.length);
  assert.ok(longest(kept) - run1.length < 100, `chemin le plus long : ${longest(kept) - run1.length} caractères après le dossier de l'essai`);
});

test('déplacement sans remplacement : sans cette fonction, ou avec une fonction qui remplace, l’auto-test échoue', async () => {
  const valueOf = (report) => report.checks.find((item) => item.name === NO_REPLACE_CHECK).value;

  // Aucune fonction : l'application ne saurait ni renommer ni déplacer.
  for (const missing of [null, undefined, 'moveNoReplace']) {
    const { code, report, outDir } = await run(createWindow(), FAST, { moveNoReplace: missing });
    assert.equal(code, 1);
    assert.deepEqual(failed(report), [NO_REPLACE_CHECK]);
    assert.deepEqual(valueOf(report), { problemes: ['fonction de déplacement sans remplacement absente'] });
    assert.deepEqual(readdirSync(path.join(path.dirname(fixtureOf(outDir)), noReplaceTest.FOLDER_NAME)), []);
  }

  // Le renommage de Node, qui remplace l'élément en place.
  const replacing = await run(createWindow(), FAST, { moveNoReplace: (from, to) => renameAsync(from, to) });
  assert.equal(replacing.code, 1);
  assert.deepEqual(failed(replacing.report), [NO_REPLACE_CHECK]);
  assert.ok(valueOf(replacing.report).problemes.includes("nom déjà pris (un fichier vers le nom d'un fichier) : le déplacement a abouti — l'occupant a été remplacé"));
  assert.ok(replacing.report.noReplace.races.lost > 0);

  // L'ancienne façon de faire — vérifier que le nom est libre, puis renommer : démasquée par les courses.
  // La vérification est demandée au système comme le renommage, sans bloquer : les déplacements simultanés d'une
  // course ont ainsi tous constaté que le nom est libre avant que le premier renommage soit demandé. Avec une
  // vérification immédiate (existsSync), l'issue dépendait de la charge de la machine : un renommage pouvait
  // s'achever avant la vérification suivante, et la course, par chance, ne rien révéler.
  const checkThenRename = async (from, to) => {
    if (await lstatAsync(to).then(() => true, () => false)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    await renameAsync(from, to);
  };
  const racy = await run(createWindow(), FAST, { moveNoReplace: checkThenRename, noReplaceRounds: 4 });
  assert.equal(racy.code, 1);
  assert.deepEqual(failed(racy.report), [NO_REPLACE_CHECK]);
  assert.ok(valueOf(racy.report).problemes.some((message) => /déplacements ont abouti vers le même nom, au lieu d'un seul$/.test(message)), JSON.stringify(valueOf(racy.report)));

  // Une fonction en panne : le contrôle échoue, l'auto-test continue jusqu'au bout.
  const broken = await run(createWindow(), FAST, { moveNoReplace: () => Promise.reject(new Error('module natif en panne')) });
  assert.equal(broken.code, 1);
  assert.deepEqual(failed(broken.report), [NO_REPLACE_CHECK]);
  assert.equal(broken.report.checks.length, FULL_CHECKS);
});

test('explorateur : chemins hors des emplacements autorisés présentés au service, selon le système', async () => {
  const attemptsOf = async (platform) => {
    const win = createWindow();
    await run(win, FAST, { platform });
    return win.webContents.executed.find((script) => script.includes('wrong.push({ chemin: target'));
  };
  const windows = await attemptsOf('win32');
  // Tels qu'ils figurent dans le code de la page : chaque barre oblique inverse y est doublée.
  const refused = [String.raw`"\\\\localhost\\C$"`, String.raw`"\\\\?\\C:\\"`, String.raw`"\\\\.\\C:\\"`, '"C:"', '"C:Users"', ':flux"', String.raw`\\NUL"`, '".."', '""', 'Introuvable', 'not-a-directory', 'not-found'];
  for (const needle of refused) {
    assert.ok(windows.includes(needle), `Windows : ${needle}`);
  }
  const others = await attemptsOf('linux');
  for (const needle of ['"relatif/dossier"', '"./dossier"', '".."', '""', 'Introuvable', 'not-a-directory', 'not-found']) {
    assert.ok(others.includes(needle), `autres systèmes : ${needle}`);
  }
  assert.ok(!others.includes('localhost'));
});

test('explorateur sous Windows : un dossier protégé est contrôlé ; si aucun ne l’est sur cette machine, simple avertissement', async () => {
  const win = createWindow();
  const { code, report } = await run(win, FAST, { platform: 'win32' });
  assert.equal(code, 0);
  assert.equal(report.checks.length, WINDOWS_CHECKS);
  const names = report.checks.map((item) => item.name);
  assert.equal(names.indexOf(PROTECTED_CHECK), names.indexOf(EXPLORER_CHECKS[5]) + 1, 'après le contrôle du dossier supprimé');
  assert.deepEqual(report.warnings, []);
  // Aller par un double-clic sur le dossier protégé, retour par « Précédent ».
  const script = win.webContents.executed.find((item) => item.includes("state.code === 'access-denied'"));
  assert.match(script, /exOpen\("[A-Z]:\\\\System Volume Information"\)/);
  assert.match(script, /state\.path === "[A-Z]:\\\\"/);
  assert.match(script, /exButton\('Précédent'\)\.click\(\)/);
  // Plusieurs dossiers connus sont proposés au service, du plus courant au moins courant.
  const probe = win.webContents.executed.find((item) => item.includes("reply.code === 'access-denied'"));
  assert.match(probe, /System Volume Information.*Program Files\\\\WindowsApps.*ProgramData\\\\Microsoft\\\\Windows\\\\SystemData/);

  // Ailleurs que sous Windows : ce contrôle n'existe pas.
  const other = await run(createWindow());
  assert.ok(!other.report.checks.some((item) => item.name === PROTECTED_CHECK));

  // Le premier dossier est lisible sur cette machine, le deuxième refuse l'accès : c'est lui qui est contrôlé,
  // après un trajet au double-clic jusqu'à son dossier parent.
  const nested = createWindow((item) => (item.includes("reply.code === 'access-denied'") ? { index: 1, tried: { svi: 'lisible' } } : true));
  const second = await run(nested, FAST, { platform: 'win32' });
  assert.equal(second.code, 0);
  assert.equal(second.report.checks.length, WINDOWS_CHECKS);
  assert.deepEqual(second.report.warnings, []);
  const { executed } = nested.webContents;
  const walk = executed.findIndex((item) => /exOpen\("[A-Z]:\\\\Program Files"\)/.test(item) && /dataset\.path === "[A-Z]:\\\\Program Files"/.test(item));
  const open = executed.findIndex((item) => item.includes("state.code === 'access-denied'"));
  assert.ok(walk > 0 && open > walk, 'le dossier parent est atteint avant le double-clic');
  assert.match(executed[open], /exOpen\("[A-Z]:\\\\Program Files\\\\WindowsApps"\)/);
  assert.match(executed[open], /state\.path === "[A-Z]:\\\\Program Files"/);
  assert.match(executed[open], /exCrumbs\(\)\.at\(-1\) === "WindowsApps"/);
  // Retour au dossier d'essai, un pas en arrière après l'autre.
  const back = executed.slice(open + 1).find((item) => item.includes("exButton(\"Précédent\").click();"));
  assert.ok(back.includes(JSON.stringify(explorerTest.FOLDER_NAME).slice(1, -1)), 'jusqu’au dossier d’essai');

  // Aucun dossier ne refuse l'accès, réponse inutilisable ou service muet : le contrôle est omis, un avertissement le dit.
  const probes = [
    [{ tried: { 'C:\\System Volume Information': 'lisible', 'C:\\Program Files\\WindowsApps': 'not-found' } }, /^dossier protégé non vérifié \(aucun refus d'accès sur cette machine : \{"C:\\\\System Volume Information":"lisible","C:\\\\Program Files\\\\WindowsApps":"not-found"\}\)$/],
    [{ index: 0, tried: {} }, /aucun refus d'accès sur cette machine : \{\}/],
    [{ index: 7 }, /aucun refus d'accès sur cette machine : \{"index":7\}/],
    [{ index: 1.5 }, /\{"index":1\.5\}/],
    [false, /aucun refus d'accès sur cette machine : false/],
    [new Error('service muet'), /\{"exception":"service muet"\}/],
  ];
  for (const [answer, warning] of probes) {
    const probing = createWindow((item) => {
      if (!item.includes("reply.code === 'access-denied'")) return true;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const skipped = await run(probing, FAST, { platform: 'win32' });
    assert.equal(skipped.code, 0, JSON.stringify(answer));
    assert.equal(skipped.report.checks.length, WINDOWS_CHECKS - 1);
    assert.ok(!skipped.report.checks.some((item) => item.name === PROTECTED_CHECK));
    assert.equal(skipped.report.warnings.length, 1);
    assert.match(skipped.report.warnings[0], warning);
    assert.ok(!probing.webContents.executed.some((item) => item.includes("state.code === 'access-denied'")), 'aucune navigation vers le dossier');
  }
});

test('explorateur : les emplacements trouvés sur la machine sont joints au rapport', async () => {
  const found = { places: ['desktop', 'documents'], drives: ['C:', 'D:'] };
  const win = createWindow((code) => (code.includes('reply.value.places.filter((place) => place.available).map') ? found : true));
  const { code, report } = await run(win);
  assert.equal(code, 0);
  assert.deepEqual(report.explorer, found);

  // Information facultative : son absence ou une panne ne change rien au résultat.
  for (const answer of [null, 'texte', () => { throw new Error('panne'); }]) {
    const other = createWindow((script) => {
      if (!script.includes('reply.value.places.filter((place) => place.available).map')) return true;
      return typeof answer === 'function' ? answer() : answer;
    });
    const result = await run(other);
    assert.equal(result.code, 0);
    assert.equal(result.report.explorer, null);
    assert.deepEqual(result.report.warnings, []);
  }
});

test('explorateur : dossier d’essai impossible à créer — erreur consignée, la suite du scénario continue', async () => {
  const outDir = freshDir();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, explorerTest.FIXTURE_DIR), 'un fichier occupe la place du dossier');
  const { code, report } = await run(createWindow(), FAST, { outDir });
  assert.equal(code, 1);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /^dossier d'essai de l'explorateur impossible à créer : /);
  assert.deepEqual(failed(report), []);
  const names = report.checks.map((item) => item.name);
  // Les contrôles qui précèdent le dossier d'essai ont eu lieu, ceux du bureau et des fenêtres aussi.
  assert.ok(names.includes(EXPLORER_CHECKS[2]));
  assert.ok(!names.includes(EXPLORER_CHECKS[4]));
  for (const name of Object.values(desktopTest.CHECKS)) assert.ok(names.includes(name), name);
  assert.equal(report.captures.includes('06-explorateur.png'), false);
  assert.equal(report.captures.includes('09-fenetres.png'), true);
});

test('explorateur : chaque exécution reçoit un dossier d’essai neuf ; un ancien essai ne fausse rien', async () => {
  const outDir = freshDir();
  const first = await run(createWindow(), FAST, { outDir });
  const second = await run(createWindow(), FAST, { outDir });
  assert.deepEqual([first.code, second.code], [0, 0]);
  const runs = readdirSync(path.join(outDir, explorerTest.FIXTURE_DIR));
  assert.equal(runs.length, 2);
  for (const name of runs) {
    assert.equal(readdirSync(path.join(outDir, explorerTest.FIXTURE_DIR, name, explorerTest.FOLDER_NAME)).length, 7);
  }
});

// ---------------------------------------------------------------------------------
// Explorateur de fichiers : opérations réelles, menées dans l'interface et contrôlées sur le disque
// ---------------------------------------------------------------------------------

const { NAMES: ITEM, WORKSHOP_NAME } = operationsTest;

/** L'atelier — le dossier des opérations — créé par l'auto-test à côté du dossier parcouru. */
const workshopOf = (outDir) => path.join(path.dirname(fixtureOf(outDir)), WORKSHOP_NAME);

/** Raison donnée aux opérations qui ne sont pas menées après un échec. */
const notRun = (operation) => ({ 'non mené': `l'opération précédente n'a pas abouti (${operation})` });

test('opérations : l’atelier est créé par l’auto-test, dans son dossier de sortie, à côté du dossier parcouru', () => {
  const run = mkdtempSync(path.join(workDir, 'atelier-'));
  const target = path.join(run, 'cible');
  mkdirSync(target);
  const workshop = operationsTest.createWorkshop(run, { linkTarget: target });
  assert.equal(workshop.folder, path.join(run, "Atelier d'essai été 2026"));
  assert.equal(workshop.link, path.join(workshop.folder, 'Lien vers le dossier parcouru'));
  const content = operationsTest.contentOf(workshop.folder);
  assert.deepEqual(Object.keys(content).sort(), [
    'Lancer.cmd',
    'Lettre à Zoé.txt',
    'Lien vers le dossier parcouru',
    "Photos d'été",
    "Photos d'été/Lettre à Zoé.txt",
    "Photos d'été/plage.jpg",
    'À jeter',
    'À jeter/brouillon.txt',
  ].sort());
  assert.deepEqual([content['Lien vers le dossier parcouru'], content["Photos d'été"], content['À jeter']], ['lien', 'dossier', 'dossier']);
  // Deux lettres du même nom, de contenus différents : un remplacement se verrait.
  assert.notEqual(content['Lettre à Zoé.txt'], content["Photos d'été/Lettre à Zoé.txt"]);

  // Le script ne fait qu'une chose : laisser un fichier témoin à côté de lui. Son texte est en ASCII, fins de ligne de Windows.
  const script = readFileSync(path.join(workshop.folder, 'Lancer.cmd'), 'latin1');
  assert.equal(script, '@echo off\r\n> "%~dp0script-execute.txt" echo execute\r\n');
  assert.match(script, /^[\x20-\x7e\r\n]+$/);

  // Sans dossier vers lequel mener, aucun lien n'est créé.
  const plain = operationsTest.createWorkshop(mkdtempSync(path.join(workDir, 'atelier-')));
  assert.equal(plain.link, null);
  assert.equal(existsSync(path.join(plain.folder, 'Lien vers le dossier parcouru')), false);
});

test('opérations : chaque opération est menée par des gestes — commandes, sélection, fenêtres de dialogue —, jamais par une demande directe', async () => {
  const win = createWindow();
  const { code, report, outDir } = await run(win);
  assert.equal(code, 0);
  const work = workshopOf(outDir);
  const quoted = (...parts) => JSON.stringify(path.join(work, ...parts));

  // Les gestes, dans l'ordre où l'utilisateur les ferait.
  const gestures = win.webContents.executed.filter(isGesture).map((script) => script.slice(OPERATION_PRELUDE.length, -' })()'.length));
  assert.deepEqual(gestures, [
    // Nouveau dossier : un nom réservé, puis le bon.
    `exOpen(${quoted()});`,
    'exCommand("new-folder").click();',
    'dialogType("CON"); dialogPress("confirm");',
    `dialogType("Reçus d'août"); dialogPress("confirm");`,
    // Coller devant un nom déjà pris : ignorer, puis conserver les deux.
    'exSelect("Lettre à Zoé.txt");',
    'exCommand("copy").click();',
    `exOpen(${quoted("Photos d'été")});`,
    'exCommand("paste").click();',
    'dialogPress("skip");',
    'exCommand("paste").click();',
    'dialogPress("keep-both");',
    // Renommer : un nom déjà pris, puis le bon.
    'exSelect("Lettre à Zoé - Copie.txt");',
    'exCommand("rename").click();',
    'dialogType("plage.jpg"); dialogPress("confirm");',
    'dialogType("Lettre relue.txt"); dialogPress("confirm");',
    // Couper, coller : annuler, puis confirmer.
    'exSelect("plage.jpg");',
    'exCommand("cut").click();',
    'exButton("Dossier parent").click();',
    `exOpen(${quoted("Reçus d'août")});`,
    'exCommand("paste").click();',
    'dialogPress("cancel");',
    'exCommand("paste").click();',
    'dialogPress("confirm");',
    // Copier un fichier et un dossier, coller.
    'exButton("Dossier parent").click();',
    `exSelect("Lettre à Zoé.txt", "Photos d'été");`,
    'exCommand("copy").click();',
    `exOpen(${quoted("Reçus d'août")});`,
    'exCommand("paste").click();',
    // Corbeille : annuler, puis confirmer.
    'exButton("Dossier parent").click();',
    'exSelect("À jeter");',
    'exCommand("delete").click();',
    'dialogPress("cancel");',
    'exSelect("À jeter"); exCommand("delete").click();',
    'dialogPress("confirm");',
    // Ouvrir le script : annuler. (Hors de Windows, rien n'est jamais confié au système.)
    `exOpen(${quoted('Lancer.cmd')});`,
    'dialogPress("cancel");',
  ]);
  // Chaque geste est suivi de l'attente de l'état qui doit en résulter, observé dans la page.
  const { executed } = win.webContents;
  for (const [index, script] of executed.entries()) {
    if (isGesture(script)) assert.ok(executed[index + 1].startsWith(OPERATION_PRELUDE) && executed[index + 1].endsWith('|| observed(); })()'), script.slice(-80));
  }

  // L'accès direct aux opérations ne sert qu'à constater des refus : deux pages, après les gestes.
  const direct = executed.filter((script) => /window\.evolve\.files|\bops\./.test(script));
  assert.equal(direct.length, 2);
  for (const script of direct) {
    assert.ok(executed.indexOf(script) > executed.findLastIndex(isGesture));
    assert.match(script, /const ops = window\.evolve\.files;/);
    assert.match(script, /return wrong\.length === 0 \|\| wrong; \}\)\(\)$/);
    // Chaque demande y est attendue comme refusée, ou comme simple question « nom déjà pris ».
    const requests = script.slice(script.indexOf('const question = async')).match(/\bops\.\w+\(/g).length;
    const expectations = script.match(/await (?:refusal|question)\(/g).length;
    assert.equal(requests, expectations);
  }

  // Le dossier de l'essai, où se trouve l'atelier, est atteint par « Dossier parent », depuis le dossier parcouru.
  const first = executed.findIndex(isGesture);
  const before = executed.slice(0, first);
  assert.ok(before.at(-1).includes(`exContent().dataset.path === ${JSON.stringify(path.dirname(work))}`));
  assert.ok(before.at(-2).includes('exButton("Dossier parent").click();'));

  // Les deux captures d'écran des opérations : la question « nom déjà pris » et la confirmation de la Corbeille.
  assert.deepEqual(report.captures.slice(6, 8), ['07-nom-deja-pris.png', '08-corbeille.png']);
});

test('opérations : à la fin, l’atelier contient exactement ce qui a été demandé ; sous Windows, la Corbeille et le script sont contrôlés', async () => {
  for (const platform of ['linux', 'win32']) {
    const win = createWindow();
    const { code, report, outDir } = await run(win, FAST, { platform });
    assert.equal(code, 0, platform);
    const work = workshopOf(outDir);
    const content = operationsTest.contentOf(work);
    const letter = content['Lettre à Zoé.txt'];
    const other = content["Photos d'été/Lettre à Zoé.txt"];
    assert.notEqual(letter, other);
    assert.deepEqual(content, {
      'Lancer.cmd': content['Lancer.cmd'],
      'Lettre à Zoé.txt': letter,
      'Lien vers le dossier parcouru': 'lien',
      "Photos d'été": 'dossier',
      // La lettre déjà rangée là n'a pas été remplacée ; la copie conservée à côté a été renommée.
      "Photos d'été/Lettre relue.txt": letter,
      "Photos d'été/Lettre à Zoé.txt": other,
      "Reçus d'août": 'dossier',
      "Reçus d'août/Lettre à Zoé.txt": letter,
      "Reçus d'août/Photos d'été": 'dossier',
      "Reçus d'août/Photos d'été/Lettre relue.txt": letter,
      "Reçus d'août/Photos d'été/Lettre à Zoé.txt": other,
      "Reçus d'août/plage.jpg": content["Reçus d'août/plage.jpg"],
      // Sous Windows seulement : le script confirmé a été exécuté.
      ...(platform === 'win32' ? { 'script-execute.txt': content['script-execute.txt'] } : {}),
    });
    assert.equal(existsSync(path.join(work, 'À jeter')), false);

    const names = report.checks.map((item) => item.name);
    const trash = names.indexOf(OPERATIONS.trash);
    if (platform === 'win32') {
      // Deux contrôles de plus : le dossier est dans la Corbeille, intact ; le script a été exécuté.
      assert.deepEqual(names.slice(trash, trash + 4), [OPERATIONS.trash, OPERATIONS.recycled, OPERATIONS.open, OPERATIONS.executed]);
      assert.equal(report.recycled.from, path.join(work, 'À jeter'));
      assert.ok(report.recycled.record.startsWith(path.join(win.recycleBin, 'S-1-5-21-')) && path.basename(report.recycled.record).startsWith('$I'));
      assert.equal(report.recycled.content, path.join(path.dirname(report.recycled.record), `$R${path.basename(report.recycled.record).slice(2)}`));
      assert.deepEqual(readdirSync(report.recycled.content), ['brouillon.txt']);
      assert.equal(readFileSync(path.join(report.recycled.content, 'brouillon.txt'), 'utf8'), 'Brouillon à jeter.\r\n');
      // Le script n'est confié à Windows qu'une fois, après la réponse « Ouvrir ».
      const gestures = win.webContents.executed.filter(isGesture).map((script) => script.slice(OPERATION_PRELUDE.length, -' })()'.length));
      assert.deepEqual(gestures.slice(-4), [`exOpen(${JSON.stringify(path.join(work, 'Lancer.cmd'))});`, 'dialogPress("cancel");', `exOpen(${JSON.stringify(path.join(work, 'Lancer.cmd'))});`, 'dialogPress("confirm");']);
    } else {
      assert.deepEqual(names.slice(trash, trash + 2), [OPERATIONS.trash, OPERATIONS.open]);
      assert.ok(!names.includes(OPERATIONS.recycled) && !names.includes(OPERATIONS.executed));
      assert.equal(report.recycled, null);
    }
  }
});

test('opérations : un explorateur fautif fait échouer l’opération en cause — créer, coller, renommer, déplacer, copier, jeter, ouvrir', async () => {
  const UI = [OPERATIONS.create, OPERATIONS.collision, OPERATIONS.rename, OPERATIONS.move, OPERATIONS.copy, OPERATIONS.trash, OPERATIONS.open];
  /** Fautes : [intitulé, moment (geste, état, fenêtre ouverte), altération du disque, opération qui doit échouer, valeur observée]. */
  const faults = [
    [
      'un nom réservé est accepté',
      (gesture, state, dialog) => dialog === 'new-folder' && state.typed === 'CON' && gesture === 'dialogPress("confirm")',
      (state) => mkdirSync(path.join(state.folder, 'CON')),
      OPERATIONS.create,
      { manquants: [], inattendus: ['CON'], modifies: [] },
    ],
    [
      'le dossier annoncé n’est pas créé',
      (gesture, state, dialog) => dialog === 'new-folder' && state.typed === ITEM.created && gesture === 'dialogPress("confirm")',
      (state) => rmSync(path.join(state.folder, ITEM.created), { recursive: true }),
      OPERATIONS.create,
      { manquants: [ITEM.created], inattendus: [], modifies: [] },
    ],
    [
      '« Ignorer » remplace l’élément en place',
      (gesture) => gesture === 'dialogPress("skip")',
      (state) => copyFileSync(state.clipboard.items[0], path.join(state.folder, ITEM.letter)),
      OPERATIONS.collision,
      { etape: 'réponse « Ignorer »', disque: { manquants: [], inattendus: [], modifies: [`${ITEM.photos}/${ITEM.letter}`] } },
    ],
    [
      '« Ignorer » copie tout de même',
      (gesture) => gesture === 'dialogPress("skip")',
      (state) => copyFileSync(state.clipboard.items[0], path.join(state.folder, ITEM.kept)),
      OPERATIONS.collision,
      { etape: 'réponse « Ignorer »', disque: { manquants: [], inattendus: [`${ITEM.photos}/${ITEM.kept}`], modifies: [] } },
    ],
    [
      '« Conserver les deux » remplace l’élément en place',
      (gesture) => gesture === 'dialogPress("keep-both")',
      (state) => copyFileSync(state.clipboard.items[0], path.join(state.folder, ITEM.letter)),
      OPERATIONS.collision,
      { manquants: [], inattendus: [], modifies: [`${ITEM.photos}/${ITEM.letter}`] },
    ],
    [
      'la copie conservée n’a pas le contenu de l’original',
      (gesture) => gesture === 'dialogPress("keep-both")',
      (state) => appendFileSync(path.join(state.folder, ITEM.kept), 'x'),
      OPERATIONS.collision,
      { manquants: [], inattendus: [], modifies: [`${ITEM.photos}/${ITEM.kept}`] },
    ],
    [
      'renommer laisse l’ancien nom à côté du nouveau',
      (gesture, state, dialog) => dialog === 'rename' && state.typed === ITEM.renamed && gesture === 'dialogPress("confirm")',
      (state) => copyFileSync(path.join(state.folder, ITEM.renamed), path.join(state.folder, ITEM.kept)),
      OPERATIONS.rename,
      { manquants: [], inattendus: [`${ITEM.photos}/${ITEM.kept}`], modifies: [] },
    ],
    [
      'renommer altère le contenu',
      (gesture, state, dialog) => dialog === 'rename' && state.typed === ITEM.renamed && gesture === 'dialogPress("confirm")',
      (state) => writeFileSync(path.join(state.folder, ITEM.renamed), 'autre contenu'),
      OPERATIONS.rename,
      { manquants: [], inattendus: [], modifies: [`${ITEM.photos}/${ITEM.renamed}`] },
    ],
    [
      'le déplacement a lieu malgré « Annuler »',
      (gesture, state, dialog) => dialog === 'move' && gesture === 'dialogPress("cancel")',
      (state) => renameSync(state.clipboard.items[0], path.join(state.folder, ITEM.picture)),
      OPERATIONS.move,
      { etape: 'réponse « Annuler »', disque: { manquants: [`${ITEM.photos}/${ITEM.picture}`], inattendus: [`${ITEM.created}/${ITEM.picture}`], modifies: [] } },
    ],
    [
      'le déplacement laisse l’original en place',
      (gesture, state, dialog) => dialog === 'move' && gesture === 'dialogPress("confirm")',
      (state) => copyFileSync(path.join(state.folder, ITEM.picture), path.join(state.folder, '..', ITEM.photos, ITEM.picture)),
      OPERATIONS.move,
      { manquants: [], inattendus: [`${ITEM.photos}/${ITEM.picture}`], modifies: [] },
    ],
    [
      'le dossier est copié sans son contenu',
      (gesture, state) => gesture === 'exCommand("paste")' && state.clipboard?.items.length === 2,
      (state) => rmSync(path.join(state.folder, ITEM.photos, ITEM.renamed)),
      OPERATIONS.copy,
      { manquants: [`${ITEM.created}/${ITEM.photos}/${ITEM.renamed}`], inattendus: [], modifies: [] },
    ],
    [
      'la copie retire l’original',
      (gesture, state) => gesture === 'exCommand("paste")' && state.clipboard?.items.length === 2,
      (state) => rmSync(state.clipboard.items[0]),
      OPERATIONS.copy,
      { manquants: [ITEM.letter], inattendus: [], modifies: [] },
    ],
    [
      'l’envoi à la Corbeille a lieu malgré « Annuler »',
      (gesture, state, dialog) => dialog === 'trash' && gesture === 'dialogPress("cancel")',
      (state) => rmSync(path.join(state.folder, ITEM.discard), { recursive: true }),
      OPERATIONS.trash,
      { etape: 'réponse « Annuler »', disque: { manquants: [ITEM.discard, `${ITEM.discard}/${ITEM.draft}`], inattendus: [], modifies: [] } },
    ],
    [
      'l’élément confirmé reste à sa place',
      (gesture, state, dialog) => dialog === 'trash' && gesture === 'dialogPress("confirm")',
      (state) => {
        mkdirSync(path.join(state.folder, ITEM.discard));
        writeFileSync(path.join(state.folder, ITEM.discard, ITEM.draft), 'Brouillon à jeter.\r\n');
      },
      OPERATIONS.trash,
      { manquants: [], inattendus: [ITEM.discard, `${ITEM.discard}/${ITEM.draft}`], modifies: [] },
    ],
    [
      'le script est exécuté malgré « Annuler »',
      (gesture, state, dialog) => dialog === 'open' && gesture === 'dialogPress("cancel")',
      (state) => writeFileSync(path.join(state.folder, ITEM.marker), 'execute\r\n'),
      OPERATIONS.open,
      { etape: 'réponse « Annuler »', disque: { manquants: [], inattendus: [ITEM.marker], modifies: [] } },
    ],
  ];
  for (const [label, when, alter, failing, value] of faults) {
    let altered = 0;
    const win = createWindow(() => true, {
      after: (gesture, state, dialog) => {
        if (altered === 0 && when(gesture, state, dialog)) {
          altered += 1;
          alter(state);
        }
      },
    });
    const { code, report } = await run(win);
    assert.equal(altered, 1, label);
    assert.equal(code, 1, label);
    // L'opération en cause échoue, valeur observée à l'appui ; les suivantes, qui partent de l'état qu'elle laisse,
    // ne sont pas menées — et le constat final signale lui aussi l'écart.
    const index = UI.indexOf(failing);
    assert.deepEqual(failed(report), [...UI.slice(index), OPERATIONS.state], label);
    assert.deepEqual(report.checks.find((item) => item.name === failing).value, value, label);
    for (const name of UI.slice(index + 1)) {
      assert.deepEqual(report.checks.find((item) => item.name === name).value, notRun(failing.split(' : ')[0]), label);
    }
    // Les autres contrôles ont tout de même lieu : leur nombre ne change pas.
    assert.equal(report.checks.length, FULL_CHECKS, label);
    assert.deepEqual(report.errors, [], label);
  }
});

test('opérations : un geste sans effet à l’écran fait échouer l’opération ; la fenêtre de dialogue restée ouverte est refermée', async () => {
  // La question « nom déjà pris » n'apparaît pas : l'état observé est consigné.
  const seen = { dialogue: null, notifications: ['Copie terminée'], selection: [], 'presse-papiers': '1 élément à coller', page: 'folder' };
  const win = createWindow((script) => (script.includes('existe déjà') && script.includes('|| observed();') ? seen : true));
  const { code, report } = await run(win);
  assert.equal(code, 1);
  assert.deepEqual(report.checks.find((item) => item.name === OPERATIONS.collision).value, { etape: 'commande « Coller »', obtenu: seen });
  assert.deepEqual(report.checks.find((item) => item.name === OPERATIONS.rename).value, notRun('« Coller » devant un nom déjà pris'));
  // Aucune réponse n'est donnée à une question qui n'a pas été posée.
  const gestures = win.webContents.executed.filter(isGesture).map((script) => script.slice(OPERATION_PRELUDE.length, -' })()'.length));
  assert.equal(gestures.at(-1), `dialog()?.querySelector('[data-action="cancel"], [data-action="close"]')?.click();`);
  assert.equal(gestures.at(-2), 'exCommand("paste").click();');
  assert.ok(!gestures.includes('dialogPress("skip");'));
  // La capture de la question n'est pas prise ; les suivantes le sont.
  assert.deepEqual(report.captures, CAPTURES.filter((name) => name !== '07-nom-deja-pris.png' && name !== '08-corbeille.png'));

  // Un geste impossible (élément absent de la page) : consigné, sans interrompre l'auto-test.
  const broken = createWindow((script) => {
    if (isGesture(script) && script.includes('exCommand("rename")')) throw new TypeError("Cannot read properties of null (reading 'click')");
    return true;
  });
  const second = await run(broken);
  assert.equal(second.code, 1);
  assert.deepEqual(second.report.checks.find((item) => item.name === OPERATIONS.rename).value, {
    etape: 'commande « Renommer »',
    geste: "impossible : Cannot read properties of null (reading 'click')",
  });
  assert.deepEqual(second.report.errors, []);
  assert.equal(second.report.checks.length, FULL_CHECKS);
});

test('opérations : les demandes à refuser sont présentées à l’application ; une seule acceptée fait échouer', async () => {
  const win = createWindow();
  const { code, outDir } = await run(win);
  assert.equal(code, 0);
  const work = workshopOf(outDir);
  const quoted = (...parts) => JSON.stringify(path.join(work, ...parts));
  const [unconfirmed, refused] = win.webContents.executed.filter((script) => script.includes('const ops = window.evolve.files;'));

  // Sans confirmation ; remplacer ; supprimer définitivement.
  const letter = quoted('Lettre à Zoé.txt');
  const photos = quoted("Photos d'été");
  for (const needle of [
    `() => ops.trash([${letter}]), "needs-confirmation"`,
    `() => ops.trash([${letter}], { confirmed: false }), "needs-confirmation"`,
    `() => ops.move([${letter}], ${photos}), "needs-confirmation"`,
    `() => ops.open(${quoted('Lancer.cmd')}), "needs-confirmation"`,
    `() => ops.copy([${letter}], ${photos}, { onCollision: 'replace' }), "bad-arguments"`,
    `() => ops.copy([${letter}], ${photos}, { overwrite: true }), "bad-arguments"`,
    `() => ops.move([${letter}], ${photos}, { confirmed: true, onCollision: 'replace' }), "bad-arguments"`,
    `() => ops.trash([${letter}], { confirmed: true, permanent: true }), "bad-arguments"`,
    `() => ops.rename(${letter}, "Lancer.cmd"), "collision"`,
    `() => ops.createFolder(${quoted()}, "Photos d'été"), "collision"`,
    // Devant un nom déjà pris, la question est posée : rien n'est copié ni déplacé.
    `await question("copier devant un nom déjà pris", () => ops.copy([${letter}], ${photos}));`,
    `await question("déplacer devant un nom déjà pris", () => ops.move([${letter}], ${photos}, { confirmed: true }));`,
  ]) {
    assert.ok(unconfirmed.includes(needle), needle);
  }

  // Emplacements de base, liens, chemins, noms.
  const link = quoted('Lien vers le dossier parcouru');
  // Chemins interdits : l'un remonte puis revient dans l'atelier, l'autre est relatif au dossier de l'essai.
  const climbing = `${work}${path.sep}..${path.sep}${WORKSHOP_NAME}`;
  const relative = `${path.basename(path.dirname(work))}${path.sep}${WORKSHOP_NAME}`;
  assert.match(relative, /^essai-[A-Za-z0-9]{6}[\\/]Atelier d'essai été 2026$/);
  const climbingLetter = JSON.stringify(path.join(climbing, 'Lettre à Zoé.txt').replace(work, climbing));
  const relativeLetter = JSON.stringify(`${relative}${path.sep}Lettre à Zoé.txt`);
  assert.equal(JSON.parse(climbingLetter), `${climbing}${path.sep}Lettre à Zoé.txt`);
  for (const needle of [
    `() => ops.rename(${JSON.stringify(path.parse(work).root)}, 'Evolve'), "protected"`,
    `await refusal('renommer le dossier personnel ' + place.id, () => ops.rename(place.path, parts.pop()), 'protected');`,
    `() => ops.createFolder(${JSON.stringify(climbing)}, 'Evolve'), "invalid-path"`,
    `() => ops.rename(${climbingLetter}, 'x.txt'), "invalid-path"`,
    `() => ops.trash([${climbingLetter}], { confirmed: true }), "invalid-path"`,
    `() => ops.rename(${relativeLetter}, 'x.txt'), "invalid-path"`,
    `() => ops.trash([${relativeLetter}], { confirmed: true }), "invalid-path"`,
    `() => ops.copy([${letter}], ${JSON.stringify(relative)}), "invalid-path"`,
    `() => ops.move([${relativeLetter}], ${photos}, { confirmed: true }), "invalid-path"`,
    `() => ops.open(''), "invalid-path"`,
    `() => ops.createFolder(${quoted()}, "CON"), "invalid-name"`,
    `() => ops.createFolder(${quoted()}, "nul.txt"), "invalid-name"`,
    `() => ops.createFolder(${quoted()}, "a/b"), "invalid-name"`,
    `() => ops.createFolder(${quoted()}, "fin."), "invalid-name"`,
    `() => ops.createFolder(${quoted()}, ""), "invalid-name"`,
    `() => ops.rename(${letter}, 'LPT1.txt'), "invalid-name"`,
    `() => ops.copy([${photos}], ${photos}), "into-itself"`,
    `() => ops.move([${photos}], ${photos}, { confirmed: true }), "into-itself"`,
    `() => ops.open(${photos}), "not-a-file"`,
    `() => ops.createFolder(), "bad-arguments"`,
    `() => ops.rename(${link}, 'Autre lien'), "link-not-supported"`,
    `() => ops.trash([${link}], { confirmed: true }), "link-not-supported"`,
    `() => ops.copy([${link}], ${photos}), "link-not-supported"`,
    `() => ops.move([${link}], ${photos}, { confirmed: true }), "link-not-supported"`,
    `() => ops.open(${link}), "link-not-supported"`,
  ]) {
    assert.ok(refused.includes(needle), needle);
  }
  // Hors de Windows : ni chemin réseau, ni dossier du système.
  assert.ok(!refused.includes('localhost') && !refused.includes('%SystemRoot%'));

  // Aucune demande ne peut nuire, même acceptée par erreur. Hors celles qui désignent l'atelier — par son
  // chemin, ou par le nom, tiré au hasard, du dossier de l'essai —, il ne reste que : un lecteur, qui ne peut
  // pas être renommé ; un chemin vide ; une demande sans argument. Et chaque dossier personnel n'est
  // « renommé » que sous son propre nom.
  const inWorkshop = (args) => args.includes(JSON.stringify(work).slice(1, -1)) || args.includes(JSON.stringify(relative).slice(1, -1));
  const requests = [...refused.matchAll(/\(\) => ops\.(\w+)\((.*)\), "[a-z-]+"\);/g)];
  assert.equal(requests.length, 40);
  assert.deepEqual(requests.filter(([, , args]) => !inWorkshop(args)).map(([, method, args]) => `${method}(${args})`).sort(), [
    `rename(${JSON.stringify(path.parse(work).root)}, 'Evolve')`,
    `open('')`,
    `createFolder()`,
  ].sort());
  assert.equal(refused.match(/\bops\.\w+\(/g).length, requests.length + 1); // + les dossiers personnels
  assert.ok(!/ops\.(?:trash|move|copy|createFolder|open)\(\s*place\b/.test(refused));
  // Ni la Corbeille, ni un déplacement, ne sont jamais demandés pour un élément extérieur à l'atelier.
  for (const [, method, args] of requests) {
    if (method === 'trash' || method === 'move') assert.ok(inWorkshop(args), `${method}(${args})`);
  }

  // Une demande acceptée, ou refusée pour une autre raison : le contrôle échoue, la demande est nommée.
  for (const [needle, name] of [["'needs-confirmation'", OPERATIONS.unconfirmed], ['link-not-supported', OPERATIONS.refused]]) {
    const wrong = [{ demande: 'déplacer, sans confirmation', attendu: 'needs-confirmation', obtenu: 'accepté' }];
    const accepting = createWindow((script) => (script.includes('const ops = window.evolve.files;') && script.includes(needle.replaceAll("'", '"')) ? wrong : true));
    const result = await run(accepting);
    assert.equal(result.code, 1);
    assert.deepEqual(failed(result.report), [name]);
    assert.deepEqual(result.report.checks.find((item) => !item.ok).value, wrong);
  }
  // La page ne répond pas : échec, lui aussi.
  const silent = createWindow((script) => {
    if (script.includes('const ops = window.evolve.files;')) throw new Error('passerelle absente');
    return true;
  });
  const third = await run(silent);
  assert.deepEqual(failed(third.report), [OPERATIONS.unconfirmed, OPERATIONS.refused]);
  assert.equal(third.report.checks.find((item) => !item.ok).value, 'exception : passerelle absente');

  // Une demande « refusée » qui laisse pourtant une trace dans l'atelier : le constat final échoue.
  const leakingDir = freshDir();
  const leaking = createWindow((script) => {
    if (script.includes('const ops = window.evolve.files;') && script.includes('invalid-name')) mkdirSync(path.join(workshopOf(leakingDir), 'CON'));
    return true;
  });
  const fourth = await run(leaking, FAST, { outDir: leakingDir });
  assert.equal(fourth.code, 1);
  assert.deepEqual(failed(fourth.report), [OPERATIONS.state]);
  assert.deepEqual(fourth.report.checks.find((item) => !item.ok).value, { manquants: [], inattendus: ['CON'], modifies: [] });
});

test('opérations sous Windows : chemins réseau et dossiers du système, « renommés » sous leur propre nom', async () => {
  // Dossiers du système imités : désignés, comme sous Windows, par des variables d'environnement.
  const system = mkdtempSync(path.join(workDir, 'systeme-'));
  const folders = { SystemRoot: path.join(system, 'Windows'), ProgramFiles: path.join(system, 'Program Files'), APPDATA: path.join(system, 'Users', 'lea', 'AppData', 'Roaming') };
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const names = ['SystemRoot', 'ProgramFiles', 'ProgramData', 'APPDATA', 'LOCALAPPDATA'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, folders, { ProgramData: path.join(system, 'Absent') });
  let executed;
  let work;
  try {
    const win = createWindow();
    const { code, outDir } = await run(win, FAST, { platform: 'win32' });
    assert.equal(code, 0);
    ({ executed } = win.webContents);
    work = workshopOf(outDir);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  const refused = executed.filter((script) => script.includes('const ops = window.evolve.files;'))[1];
  const letter = path.join(work, 'Lettre à Zoé.txt');
  const relative = `${path.basename(path.dirname(work))}${path.sep}${WORKSHOP_NAME}${path.sep}Lettre à Zoé.txt`;
  // Chacune de ces formes désigne la lettre de l'atelier, ou rien. Sur une machine Windows, l'atelier est sur
  // un lecteur désigné par une lettre (« C:\… ») ; ailleurs (« /tmp/… »), « C » en tient lieu.
  const onDrive = /^[A-Za-z]:\\/.test(letter);
  const drive = onDrive ? letter[0] : 'C';
  const afterRoot = letter.slice(onDrive ? 3 : 1);
  for (const needle of [
    `() => ops.rename(${JSON.stringify(`\\\\localhost\\${drive}$\\${afterRoot}`)}, 'x.txt'), "invalid-path"`,
    `() => ops.rename(${JSON.stringify(`\\\\?\\${letter}`)}, 'x.txt'), "invalid-path"`,
    `() => ops.trash([${JSON.stringify(`${letter}:flux`)}], { confirmed: true }), "invalid-path"`,
    `() => ops.rename(${JSON.stringify(`${drive}:${relative}`)}, 'x.txt'), "invalid-path"`,
    `() => ops.open(${JSON.stringify(`${work}\\NUL`)}), "invalid-path"`,
    // Chaque dossier du système présent sur la machine, par son emplacement réel et sous son propre nom.
    `await refusal("renommer le dossier du système %SystemRoot%", () => ops.rename(${JSON.stringify(realpathSync.native(folders.SystemRoot))}, "Windows"), "protected");`,
    `await refusal("renommer le dossier du système %ProgramFiles%", () => ops.rename(${JSON.stringify(realpathSync.native(folders.ProgramFiles))}, "Program Files"), "protected");`,
    `await refusal("renommer le dossier du système %APPDATA%", () => ops.rename(${JSON.stringify(realpathSync.native(folders.APPDATA))}, "Roaming"), "protected");`,
  ]) {
    assert.ok(refused.includes(needle), needle);
  }
  // Variable absente, ou dossier introuvable : aucune demande.
  assert.ok(!refused.includes('%ProgramData%') && !refused.includes('%LOCALAPPDATA%'));
});

test('opérations sous Windows : un dossier absent de la Corbeille, ou qui n’y est pas intact, fait échouer', async () => {
  /** Fautes : [intitulé, altération de la Corbeille après l'envoi, valeur observée]. */
  const faults = [
    [
      'supprimé définitivement : ni fiche, ni élément',
      (owner) => rmSync(owner, { recursive: true }),
      (found) => assert.deepEqual(found.value, { corbeille: found.bin, 'élément recherché': found.from, 'trouvé': false }),
    ],
    [
      'fiche sans élément',
      (owner) => rmSync(path.join(owner, readdirSync(owner).find((name) => name.startsWith('$R'))), { recursive: true }),
      (found) => assert.deepEqual([Object.keys(found.value), found.value['élément']], [['fiche', 'élément'], 'absent de la Corbeille']),
    ],
    [
      'contenu perdu en route',
      (owner) => rmSync(path.join(owner, readdirSync(owner).find((name) => name.startsWith('$R')), ITEM.draft)),
      (found) => assert.deepEqual(found.value, { manquants: [ITEM.draft], inattendus: [], modifies: [] }),
    ],
    [
      'contenu altéré',
      (owner) => writeFileSync(path.join(owner, readdirSync(owner).find((name) => name.startsWith('$R')), ITEM.draft), 'autre'),
      (found) => assert.deepEqual(found.value, { manquants: [], inattendus: [], modifies: [ITEM.draft] }),
    ],
    [
      'fiche d’un autre emplacement',
      (owner) => {
        const record = path.join(owner, readdirSync(owner).find((name) => name.startsWith('$I')));
        const bytes = readFileSync(record);
        bytes.write('X', 28, 'utf16le'); // premier caractère du chemin d'origine
        writeFileSync(record, bytes);
      },
      (found) => assert.equal(found.value['trouvé'], false),
    ],
  ];
  for (const [label, alter, verify] of faults) {
    const win = createWindow(() => true, {
      after: (gesture, state, dialog) => {
        if (dialog === 'trash' && gesture === 'dialogPress("confirm")') alter(path.join(state.bin, readdirSync(state.bin)[0]));
      },
    });
    const { code, report, outDir } = await run(win, FAST, { platform: 'win32' });
    assert.equal(code, 1, label);
    // Seul ce contrôle échoue : le dossier a bien quitté l'atelier, et la suite des opérations a lieu.
    assert.deepEqual(failed(report), [OPERATIONS.recycled], label);
    assert.equal(report.checks.length, WINDOWS_CHECKS, label);
    assert.equal(report.recycled, null, label);
    verify({ value: report.checks.find((item) => !item.ok).value, bin: win.recycleBin, from: path.join(workshopOf(outDir), ITEM.discard) });
  }

  // Corbeille désignée mais introuvable (lecteur sans Corbeille) : échec, et non contrôle omis.
  const absent = createWindow();
  const result = await run(absent, FAST, { platform: 'win32', recycleBin: path.join(workDir, 'aucune-corbeille') });
  assert.deepEqual(failed(result.report), [OPERATIONS.recycled]);

  // L'envoi à la Corbeille n'a pas abouti : la Corbeille n'est pas examinée.
  const stuck = createWindow(() => true, {
    after: (gesture, state, dialog) => {
      if (dialog === 'trash' && gesture === 'dialogPress("cancel")') rmSync(path.join(state.folder, ITEM.discard), { recursive: true });
    },
  });
  const third = await run(stuck, FAST, { platform: 'win32' });
  assert.deepEqual(failed(third.report), [OPERATIONS.trash, OPERATIONS.recycled, OPERATIONS.open, OPERATIONS.executed, OPERATIONS.state]);
  assert.deepEqual(third.report.checks.find((item) => item.name === OPERATIONS.recycled).value, notRun('« Envoyer à la Corbeille »'));

  // Hors de Windows, une Corbeille peut être désignée : elle est alors examinée de la même façon.
  const elsewhere = createWindow();
  const fourth = await run(elsewhere, FAST, { recycleBin: elsewhere.recycleBin });
  assert.equal(fourth.code, 0);
  assert.equal(fourth.report.checks.length, FULL_CHECKS + 1);
  assert.equal(fourth.report.recycled.from, path.join(workshopOf(fourth.outDir), ITEM.discard));
});

test('opérations sous Windows : le script confirmé doit réellement s’exécuter — fichier témoin attendu, même tardif', async () => {
  // Windows n'exécute rien : le fichier témoin n'apparaît pas.
  const idle = createWindow(() => true, {
    after: (gesture, state, dialog) => {
      if (dialog === 'open' && gesture === 'dialogPress("confirm")') rmSync(path.join(state.folder, ITEM.marker));
    },
  });
  const first = await run(idle, { ...FAST, response: 60 }, { platform: 'win32' });
  assert.equal(first.code, 1);
  assert.deepEqual(failed(first.report), [OPERATIONS.executed]);
  assert.deepEqual(first.report.checks.find((item) => !item.ok).value, { 'fichier témoin': 'absent', attendu: path.join(workshopOf(first.outDir), ITEM.marker) });

  // Le script met un moment à s'exécuter : le fichier témoin est attendu.
  const slow = createWindow(() => true, {
    after: (gesture, state, dialog) => {
      if (dialog !== 'open' || gesture !== 'dialogPress("confirm")') return;
      const marker = path.join(state.folder, ITEM.marker);
      rmSync(marker);
      setTimeout(() => writeFileSync(marker, 'execute \r\n'), 40);
    },
  });
  const second = await run(slow, { ...FAST, response: 2_000 }, { platform: 'win32' });
  assert.equal(second.code, 0);
  // Son contenu importe peu : seule sa présence prouve l'exécution.
  assert.equal(readFileSync(path.join(workshopOf(second.outDir), ITEM.marker), 'utf8'), 'execute \r\n');

  // Le script laisse autre chose que son fichier témoin : l'atelier n'a plus le contenu attendu.
  const messy = createWindow(() => true, {
    after: (gesture, state, dialog) => {
      if (dialog === 'open' && gesture === 'dialogPress("confirm")') writeFileSync(path.join(state.folder, 'autre.txt'), '');
    },
  });
  const third = await run(messy, FAST, { platform: 'win32' });
  assert.deepEqual(failed(third.report), [OPERATIONS.executed, OPERATIONS.state]);
  assert.deepEqual(third.report.checks.find((item) => !item.ok).value, { manquants: [], inattendus: ['autre.txt'], modifies: [] });
});

test('opérations : lien d’essai impossible à créer — les autres refus sont contrôlés, un avertissement le signale', async () => {
  const fsModule = require('node:fs');
  const original = fsModule.symlinkSync;
  fsModule.symlinkSync = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
  };
  let result;
  let win;
  try {
    win = createWindow();
    result = await run(win);
  } finally {
    fsModule.symlinkSync = original;
  }
  assert.equal(result.code, 0);
  assert.equal(result.report.checks.length, FULL_CHECKS);
  assert.deepEqual(result.report.warnings, ["lien d'essai impossible à créer sur cette machine : le refus des opérations sur les liens n'a pas été vérifié"]);
  const refused = win.webContents.executed.filter((script) => script.includes('const ops = window.evolve.files;'))[1];
  assert.ok(!refused.includes('link-not-supported') && refused.includes('into-itself'));
  assert.equal(existsSync(path.join(workshopOf(result.outDir), ITEM.link)), false);
});

// ---------------------------------------------------------------------------------
// Services et scénarios
// ---------------------------------------------------------------------------------

test('le contrôle complet vérifie que la page joint les services et que ceux-ci refusent une demande invalide', async () => {
  const { report } = await run(createWindow());
  const name = "services d'Evolve joignables depuis l'interface (réglages)";
  assert.ok(report.checks.some((item) => item.name === name && item.ok));

  // Passerelle sans services (ancienne version) : le contrôle échoue, seul.
  const win = createWindow((code) => (code.includes("services.call('settings', 'getAll')") ? { values: undefined } : true));
  const broken = await run(win);
  assert.equal(broken.code, 1);
  assert.deepEqual(failed(broken.report), [name]);
});

test('l’état des services est joint au rapport ; son absence est un simple avertissement', async () => {
  const described = {
    settings: { state: 'available', storage: 'memory', file: null },
    files: { state: 'available', access: 'read-only', places: 6, drives: 1, methods: ['places', 'list'], events: [] },
    'file-operations': SOUND_OPERATIONS,
  };
  const first = await run(createWindow(), FAST, { describeServices: () => described });
  assert.equal(first.code, 0);
  assert.deepEqual(first.report.services, described);

  const second = await run(createWindow(), FAST, {
    describeServices: () => {
      throw new Error('inventaire en panne');
    },
  });
  assert.equal(second.code, 0);
  assert.equal(second.report.services, null);
  assert.deepEqual(second.report.warnings, ['état des services indisponible : inventaire en panne']);
});

test('scénario inconnu : échec, sans rien exécuter dans la page', async () => {
  for (const scenario of ['inconnu', 'constructor', '__proto__', 'toString', '']) {
    const win = createWindow();
    const { code, report } = await run(win, FAST, { scenario });
    assert.equal(code, 1, scenario);
    assert.equal(report.ok, false);
    assert.equal(report.scenario, scenario);
    assert.deepEqual(report.checks, []);
    assert.deepEqual(report.errors, [`scénario d'auto-test inconnu : ${scenario}`]);
    assert.equal(win.webContents.executed.length, 0);
    assert.equal(win.showCalls, 0);
  }
});

test('scénarios des réglages : les valeurs attendues sont de vrais réglages, différents des valeurs par défaut', () => {
  const defaults = defaultsOf(SETTINGS);
  assert.ok(Object.keys(CHANGED_SETTINGS).length >= 5);
  for (const [key, value] of Object.entries(CHANGED_SETTINGS)) {
    assert.ok(Object.hasOwn(SETTINGS, key), key);
    assert.notEqual(value, defaults[key], `${key} : une valeur égale à la valeur par défaut ne prouverait rien`);
  }
  // Interrupteurs et curseurs, bureau et paramètres rapides : chaque nature de réglage est couverte.
  const kinds = new Set(Object.keys(CHANGED_SETTINGS).map((key) => `${key.split('.')[0]}:${SETTINGS[key].type}`));
  assert.deepEqual([...kinds].sort(), ['desktop:boolean', 'quick:boolean', 'quick:integer']);
  // Tous les réglages sont attendus à une valeur exacte, sauf l'emplacement de la fenêtre de l'explorateur :
  // ses valeurs dépendent de l'écran, et sont comparées à la fenêtre elle-même.
  const placement = Object.fromEntries(PLACEMENT_SETTINGS.map((key) => [key, defaults[key]]));
  assert.deepEqual({ ...EXPECTED_SETTINGS, ...placement }, { ...defaults, ...CHANGED_SETTINGS });
  assert.deepEqual([...Object.keys(EXPECTED_SETTINGS), ...PLACEMENT_SETTINGS], Object.keys(SETTINGS));
  for (const key of PLACEMENT_SETTINGS) assert.equal(Object.hasOwn(EXPECTED_SETTINGS, key), false, key);
});

/** Contrôles du premier lancement qui précèdent le placement de la fenêtre. */
const SETTINGS_WRITE_CHECKS = [
  "l'interface a démarré",
  'premier lancement : chaque réglage a sa valeur par défaut',
  'les réglages sont enregistrés dans un fichier',
  "le panneau des paramètres rapides s'ouvre",
  "l'interface affiche les réglages modifiés",
  'le service des réglages a reçu chaque changement',
];

/** Zone de travail d'une fenêtre de 1600 × 900, et place qu'y prend l'explorateur à sa première ouverture. */
const WORK_AREA = { x: 0, y: 0, w: 1600, h: 852 };
const OPENED_AT = { x: 304, y: 77, w: 992, h: 640 };

/**
 * Réponses d'une page où la fenêtre de l'explorateur occupe `rect` dans la
 * zone de travail `area` ; les autres questions vont à `answer`.
 */
const placed = (rect = OPENED_AT, area = WORK_AREA, answer = () => true) => (script, webContents) => {
  if (script.includes('return (pRect(pWin()));')) return rect;
  if (script.includes('return (pArea());')) return area;
  return answer(script, webContents);
};

test('scénario « settings-write » : réglages modifiés par des gestes dans l’interface, fenêtre déplacée à la souris, le tout confirmé par le service', async () => {
  const win = createWindow(placed());
  const { code, report, outDir } = await run(win, FAST, { scenario: 'settings-write' });
  assert.equal(code, 0);
  assert.equal(report.scenario, 'settings-write');
  assert.deepEqual(report.checks.map((item) => item.name), [...SETTINGS_WRITE_CHECKS, PLACEMENT_CHECKS.untouched, PLACEMENT_CHECKS.moved, PLACEMENT_CHECKS.stored]);
  assert.deepEqual(report.captures, ['01-reglages-modifies.png', '02-fenetre-placee.png']);
  assert.deepEqual(readdirSync(outDir).sort(), ['01-reglages-modifies.png', '02-fenetre-placee.png', 'result.json']);
  assert.deepEqual(report.input, { souris: true, clavier: true, pageActive: true });
  assert.deepEqual(report.warnings, []);

  const { executed, inputs } = win.webContents;
  for (const script of executed) assert.doesNotThrow(() => new vm.Script(script), `code invalide : ${script.slice(0, 120)}…`);
  // Des gestes d'utilisateur — clics et curseurs — et non des appels directs au service.
  const actions = executed.filter((script) => /\.click\(\)|dispatchEvent/.test(script));
  assert.equal(actions.length, 8);
  for (const needle of ['data-setting="nightLight"', 'data-setting="doNotDisturb"', "input.value = '60'", "input.value = '35'", '.tb-widgets', `.tb-app[data-app="explorer"]`]) {
    assert.equal(actions.filter((script) => script.includes(needle)).length, 1, needle);
  }
  // Le panneau des paramètres rapides est ouvert, puis refermé avant d'ouvrir l'explorateur.
  assert.equal(actions.filter((script) => script.includes('.tb-tray')).length, 2);
  assert.ok(!executed.some((script) => /services\.call\('settings', '(?:set|reset)'/.test(script)), 'aucune écriture directe');

  // La fenêtre est déplacée par un vrai glissement : bouton enfoncé sur la barre de titre, tenu, puis relâché plus loin.
  const mouse = inputs.filter((event) => event.type.startsWith('mouse'));
  const down = mouse.findIndex((event) => event.type === 'mouseDown');
  const up = mouse.findIndex((event) => event.type === 'mouseUp');
  assert.ok(down > 0 && up > down + 2, 'appui, déplacement, relâchement');
  assert.ok(mouse.slice(down + 1, up).every((event) => event.type === 'mouseMove' && event.modifiers.includes('leftButtonDown')));
  // Saisie dans la barre de titre (14 points sous le haut de la fenêtre, à 260 points de son bord gauche), lâchée 64 points à droite et 32 plus bas.
  assert.deepEqual({ x: mouse[down].x, y: mouse[down].y }, { x: 304 + 260, y: 77 + 14 });
  assert.deepEqual({ x: mouse[up].x, y: mouse[up].y }, { x: 304 + 260 + 64, y: 77 + 14 + 32 });
  assert.equal(mouse.filter((event) => event.type === 'mouseDown').length, 1, 'un seul geste');
  // Rien n'est retenu avant le geste ; après, la fenêtre puis le service doivent en être à la place exacte visée.
  const moved = JSON.stringify({ x: 368, y: 109, w: 992, h: 640 });
  assert.ok(executed.some((script) => script.includes(`stored.units?.w === 0 && stored.units?.h === 0 && stored.maximized === false`)));
  assert.ok(executed.some((script) => script.includes(`!el.classList.contains('is-maximized') && pSame(pRect(el), ${moved}, 0)`)), 'au pixel près');
  assert.ok(executed.some((script) => script.includes(`stored.kept === true && stored.maximized === false && pSame(stored.pixels, ${moved}, 1)`)));
});

test('scénario « settings-write » : la fenêtre est déplacée du côté où elle reste entière à l’écran', async () => {
  // Plus de place à droite ni en bas : vers la gauche, sans descendre.
  const cornered = { x: 700, y: 300, w: 900, h: 552 };
  const win = createWindow(placed(cornered));
  const { code, report } = await run(win, FAST, { scenario: 'settings-write' });
  assert.equal(code, 0);
  assert.deepEqual(report.warnings, []);
  const mouse = win.webContents.inputs.filter((event) => event.type.startsWith('mouse'));
  const down = mouse.find((event) => event.type === 'mouseDown');
  const up = mouse.find((event) => event.type === 'mouseUp');
  assert.deepEqual({ x: up.x - down.x, y: up.y - down.y }, { x: -64, y: 0 });
  assert.ok(win.webContents.executed.some((script) => script.includes(`pSame(stored.pixels, ${JSON.stringify({ x: 636, y: 300, w: 900, h: 552 })}, 1)`)));

  // Calcul du déplacement : vers la droite et le bas s'il y a la place, sinon vers la gauche, sinon du peu qui reste — jamais hors de la zone, jamais vers le haut.
  const area = { w: 1600, h: 852 };
  assert.deepEqual(shiftInside(OPENED_AT, area), { dx: 64, dy: 32 });
  assert.deepEqual(shiftInside(cornered, area), { dx: -64, dy: 0 });
  assert.deepEqual(shiftInside({ x: 1000, y: 0, w: 580, h: 830 }, area), { dx: -64, dy: 22 });
  assert.deepEqual(shiftInside({ x: 20, y: 10, w: 920, h: 530 }, { w: 960, h: 552 }), { dx: 20, dy: 12 }, 'le peu de place à droite');
  assert.deepEqual(shiftInside({ x: 30, y: 10, w: 920, h: 530 }, { w: 960, h: 552 }), { dx: -30, dy: 12 }, 'le peu de place à gauche');
  assert.deepEqual(shiftInside({ x: 0, y: 0, w: 960, h: 552 }, { w: 960, h: 552 }), { dx: 0, dy: 0 });
  assert.deepEqual(shiftInside({ x: -40, y: -10, w: 1100, h: 700 }, { w: 960, h: 552 }), { dx: 0, dy: 0 }, 'fenêtre plus grande que la zone');
  assert.deepEqual(shiftInside(null, null), { dx: 0, dy: 0 });
  for (const rect of [OPENED_AT, cornered, { x: 1000, y: 0, w: 580, h: 830 }, { x: 3, y: 840, w: 1590, h: 12 }]) {
    const { dx, dy } = shiftInside(rect, area);
    assert.ok(rect.x + dx >= 0 && rect.x + rect.w + dx <= area.w && dy >= 0 && rect.y + rect.h + dy <= area.h, JSON.stringify(rect));
  }
});

test('scénario « settings-write », fenêtre sans place autour d’elle : elle n’est pas sortie de l’écran, mais agrandie — et le rapport le dit', async () => {
  const win = createWindow(placed({ x: 0, y: 0, w: 1600, h: 852 }));
  const { code, report } = await run(win, FAST, { scenario: 'settings-write' });
  assert.equal(code, 0);
  assert.deepEqual(report.checks.map((item) => item.name), [...SETTINGS_WRITE_CHECKS, PLACEMENT_CHECKS.untouched, PLACEMENT_CHECKS.maximized, PLACEMENT_CHECKS.stored]);
  // La souris est bien reçue : ce n'est pas elle qui manque.
  assert.equal(report.input.souris, true);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /^fenêtre de l'explorateur non déplacée : sans place à sa droite, à sa gauche ni au-dessous, elle ne peut être déplacée sans sortir de la zone de travail\. Elle a été agrandie depuis son menu/);
  assert.equal(win.webContents.inputs.some((event) => event.type === 'mouseDown'), false, 'aucun glissement');
});

test('scénario « settings-write » sans souris : la fenêtre est agrandie depuis son menu, et le rapport dit ce qui n’a pas été vérifié', async () => {
  const win = createWindow(placed(), { input: false });
  const { code, report } = await run(win, FAST, { scenario: 'settings-write' });
  assert.equal(code, 0);
  assert.deepEqual(report.checks.map((item) => item.name), [...SETTINGS_WRITE_CHECKS, PLACEMENT_CHECKS.untouched, PLACEMENT_CHECKS.maximized, PLACEMENT_CHECKS.stored]);
  assert.equal(report.checks.some((item) => item.name === PLACEMENT_CHECKS.moved), false, 'un déplacement non fait n’est pas compté');
  assert.deepEqual(report.input, { souris: false, clavier: false, pageActive: false });
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /^fenêtre de l'explorateur non déplacée : la page ne reçoit pas la souris injectée\. Elle a été agrandie depuis son menu/);
  assert.deepEqual(report.captures, ['01-reglages-modifies.png', '02-fenetre-placee.png']);

  const { executed } = win.webContents;
  for (const script of executed) assert.doesNotThrow(() => new vm.Script(script), `code invalide : ${script.slice(0, 120)}…`);
  assert.ok(executed.some((script) => script.endsWith(`dMenuPick('Agrandir'); })()`)), 'commande « Agrandir » du menu de la fenêtre');
  // La fenêtre doit occuper toute la zone de travail.
  assert.ok(executed.some((script) => script.includes(`el.classList.contains('is-maximized') && pSame(pRect(el), ${JSON.stringify({ x: 0, y: 0, w: 1600, h: 852 })})`)));
  // Retenus : l'agrandissement, et la place que la fenêtre retrouvera une fois restaurée — celle qu'elle avait.
  assert.ok(executed.some((script) => script.includes(`stored.kept === true && stored.maximized === true && pSame(stored.pixels, ${JSON.stringify(OPENED_AT)}, 1)`)));
  assert.ok(!executed.some((script) => /services\.call\('settings', '(?:set|reset)'/.test(script)), 'aucune écriture directe');
});

test('scénario « settings-write » : une fenêtre qui ne prend pas la place demandée, ou un emplacement non reçu par le service, fait échouer', async () => {
  // Le déplacement n'a pas lieu : le contrôle échoue avec la place attendue, et l'enregistrement n'est pas examiné.
  const still = { attendu: { x: 368, y: 109, w: 992, h: 640 }, fenetre: OPENED_AT };
  const stuck = createWindow(placed(OPENED_AT, WORK_AREA, (script) => (script.includes(`!el.classList.contains('is-maximized') && pSame(pRect(el), `) ? still : true)));
  const first = await run(stuck, FAST, { scenario: 'settings-write' });
  assert.equal(first.code, 1);
  assert.deepEqual(failed(first.report), [PLACEMENT_CHECKS.moved]);
  assert.deepEqual(first.report.checks.find((item) => !item.ok).value, still);
  assert.equal(first.report.checks.some((item) => item.name === PLACEMENT_CHECKS.stored), false);

  // Le service n'a rien reçu.
  const nothing = { attendu: { x: 368, y: 109, w: 992, h: 640 }, retenu: { units: { x: 0, y: 0, w: 0, h: 0 }, maximized: false, kept: false } };
  const deaf = createWindow(placed(OPENED_AT, WORK_AREA, (script) => (script.includes('stored.kept === true && stored.maximized === false') ? nothing : true)));
  const second = await run(deaf, FAST, { scenario: 'settings-write' });
  assert.equal(second.code, 1);
  assert.deepEqual(failed(second.report), [PLACEMENT_CHECKS.stored]);

  // Un emplacement déjà retenu avant tout geste (ouvrir l'explorateur aurait écrit) : échec, et le geste n'est pas tenté.
  const early = createWindow(placed(OPENED_AT, WORK_AREA, (script) => (script.includes('stored.units?.w === 0') ? { retenu: { units: { x: 1900, y: 481, w: 6200, h: 4000 } } } : true)));
  const third = await run(early, FAST, { scenario: 'settings-write' });
  assert.equal(third.code, 1);
  assert.deepEqual(failed(third.report), [PLACEMENT_CHECKS.untouched]);
  assert.equal(early.webContents.inputs.length, 0, 'aucun geste injecté');
});

test('scénario « settings-read » : aucune modification — des constats, l’ouverture du panneau, puis celle de l’explorateur', async () => {
  const win = createWindow();
  const { code, report } = await run(win, FAST, { scenario: 'settings-read' });
  assert.equal(code, 0);
  assert.deepEqual(report.checks.map((item) => item.name), [
    "l'interface a démarré",
    "nouveau lancement : l'interface affiche les réglages enregistrés, sans aucune action",
    'leurs effets sont appliqués : teinte nocturne, luminosité réduite, widgets masqués',
    'le service des réglages restitue les valeurs enregistrées',
    'le fichier des réglages a été relu sans incident',
    "le panneau des paramètres rapides s'ouvre",
    PLACEMENT_CHECKS.restored,
  ]);
  assert.deepEqual(report.captures, ['01-reglages-restaures.png', '02-fenetre-retrouvee.png']);
  assert.equal(report.input, null, 'aucun geste de souris ni de clavier dans ce lancement');

  const { executed, inputs } = win.webContents;
  for (const script of executed) assert.doesNotThrow(() => new vm.Script(script), `code invalide : ${script.slice(0, 120)}…`);
  // Ni geste injecté, ni événement fabriqué, ni saisie, ni écriture directe : la fenêtre n'est ni déplacée ni agrandie.
  assert.deepEqual(inputs, []);
  assert.ok(!executed.some((script) => /dispatchEvent|\.value = |services\.call\('settings', '(?:set|reset)'/.test(script)), 'aucun réglage touché');
  // Trois clics seulement : le panneau ouvert, puis refermé, puis l'explorateur ouvert depuis la barre des tâches.
  const clicks = executed.filter((script) => script.includes('.click()'));
  assert.deepEqual(clicks.map((script) => (script.includes('.tb-tray') ? 'panneau' : script.includes(`.tb-app[data-app="explorer"]`) ? 'explorateur' : 'autre')), ['panneau', 'panneau', 'explorateur']);
  // Le constat précède toute action : l'ouverture du panneau vient après le dernier contrôle des réglages.
  const firstClick = executed.findIndex((script) => script.includes('.click()'));
  const lastSettingsCheck = executed.findLastIndex((script) => script.includes("services.call('settings', 'state')"));
  assert.ok(firstClick > lastSettingsCheck);

  // La place attendue de la fenêtre vient du service des réglages, convertie pour cet écran ; elle est comparée à la fenêtre.
  const restored = executed.filter((script) => script.includes('if (stored.kept !== true) return'));
  assert.equal(restored.length >= 1, true);
  assert.ok(restored[0].includes(`el.classList.contains('is-maximized') && pSame(rect, { x: 0, y: 0, w: area.w, h: area.h })`));
  assert.ok(restored[0].includes(`!el.classList.contains('is-maximized') && pSame(rect, stored.pixels)`));
});

test('scénario « settings-read » : une fenêtre rouverte ailleurs, ou sans emplacement retenu, fait échouer', async () => {
  const elsewhere = { attendu: { units: { x: 2300, y: 681, w: 6200, h: 4000 }, pixels: { x: 368, y: 109, w: 992, h: 640 }, maximized: false, kept: true }, fenetre: { x: 304, y: 77, w: 992, h: 640 }, agrandie: false };
  const moved = createWindow((script) => (script.includes('if (stored.kept !== true) return') ? elsewhere : true));
  const first = await run(moved, FAST, { scenario: 'settings-read' });
  assert.equal(first.code, 1);
  assert.deepEqual(failed(first.report), [PLACEMENT_CHECKS.restored]);
  assert.deepEqual(first.report.checks.find((item) => !item.ok).value, elsewhere);

  const none = { 'aucun emplacement retenu': { units: { x: 0, y: 0, w: 0, h: 0 }, maximized: false, kept: false } };
  const forgotten = createWindow((script) => (script.includes('if (stored.kept !== true) return') ? none : true));
  const second = await run(forgotten, FAST, { scenario: 'settings-read' });
  assert.equal(second.code, 1);
  assert.deepEqual(second.report.checks.find((item) => !item.ok).value, none);
});

test('scénarios des réglages : un réglage non retrouvé fait échouer le test, valeur observée à l’appui', async () => {
  const observed = { 'desktop.widgetsVisible': true, 'quick.nightLight': false, 'quick.doNotDisturb': false, 'quick.brightness': 100, 'quick.volume': 64 };
  const win = createWindow((code) => (code.includes('const state = shown()') ? observed : true));
  const { code, report } = await run(win, FAST, { scenario: 'settings-read' });
  assert.equal(code, 1);
  assert.deepEqual(failed(report), ["nouveau lancement : l'interface affiche les réglages enregistrés, sans aucune action"]);
  assert.deepEqual(report.checks.find((item) => !item.ok).value, observed);

  // Réglages gardés en mémoire seulement : le premier lancement échoue lui aussi.
  const memory = { ok: true, value: { storage: 'memory', durable: false, problem: null, recovered: null } };
  const volatile = createWindow((script) => (script.includes("'state'") ? memory : true));
  const second = await run(volatile, FAST, { scenario: 'settings-write' });
  assert.equal(second.code, 1);
  assert.deepEqual(failed(second.report), ['les réglages sont enregistrés dans un fichier']);
});

// ---------------------------------------------------------------------------------
// Scénario « documents-missing » : un dossier Documents absent est annoncé, jamais créé
// ---------------------------------------------------------------------------------

/** Emplacements d'une machine dont le dossier Documents n'existe pas. */
const WITHOUT_DOCUMENTS = Object.freeze({
  places: [
    { id: 'desktop', path: '/home/lea/Bureau', available: true },
    { id: 'documents', path: null, available: false },
    { id: 'downloads', path: '/home/lea/Téléchargements', available: true },
    { id: 'pictures', path: null, available: false },
    { id: 'music', path: '/home/lea/Musique', available: true },
    { id: 'videos', path: null, available: false },
  ],
  drives: ['/'],
});

/** Vrai pour la première question du scénario : la liste des emplacements. */
const asksPlaces = (script) => script.includes('reply.value.drives.map((drive) => drive.id)');

/** Fausse fenêtre dont le service de fichiers répond `places` ; tout le reste est conforme, sauf `answer`. */
const documentsWindow = (places = WITHOUT_DOCUMENTS, answer = () => true) =>
  createWindow((script, webContents) => (asksPlaces(script) ? (typeof places === 'function' ? places() : places) : answer(script, webContents)));

const DOCUMENTS_CHECKS = ["l'interface a démarré", ...Object.values(documentsTest.CHECKS)];

test('scénario « documents-missing » : le dossier absent est ouvert par trois chemins, et le message attendu à chaque fois', async () => {
  assert.equal(documentsTest.SCENARIO, 'documents-missing');
  const win = documentsWindow();
  const { code, report, outDir } = await run(win, FAST, { scenario: 'documents-missing' });
  assert.equal(code, 0, JSON.stringify(report.checks));
  assert.equal(report.scenario, 'documents-missing');
  assert.deepEqual(report.checks.map((item) => item.name), DOCUMENTS_CHECKS);
  assert.equal(new Set(DOCUMENTS_CHECKS).size, 9, 'intitulés tous différents');
  assert.deepEqual(failed(report), []);
  assert.deepEqual([report.errors, report.warnings], [[], []]);
  assert.deepEqual(report.captures, ['01-documents-absent.png']);
  // Les emplacements trouvés sont joints au rapport ; aucun dossier d'essai n'est créé pour ce scénario.
  assert.deepEqual(report.explorer, { places: ['desktop', 'downloads', 'music'], drives: ['/'] });
  assert.deepEqual(readdirSync(outDir).sort(), ['01-documents-absent.png', 'result.json']);

  const { executed } = win.webContents;
  for (const script of executed) assert.doesNotThrow(() => new vm.Script(script), `code invalide : ${script.slice(0, 120)}…`);

  // Les gestes d'un utilisateur, dans l'ordre : explorateur, tuile, précédent, volet, icône du bureau (la fenêtre
  // affiche déjà le dossier), « Ce PC », icône du bureau (plus aucune fenêtre ne l'affiche), actualiser, autre dossier.
  const gestures = executed
    .map((script) => script.slice(script.indexOf(documentsTest.NOTHING_CREATED) + 1 || 0))
    .map((script) => {
      if (script.includes(`.tb-app[data-app="explorer"]').click()`)) return 'explorateur';
      if (script.includes(`exOpen('place:documents')`)) return 'tuile';
      if (script.includes(`exButton('Précédent').click()`)) return 'précédent';
      if (script.includes(`.ex-side[data-id="place:documents"]').click()`)) return 'volet';
      if (script.includes(`.ex-side[data-id="pc"]').click()`)) return 'ce pc';
      if (script.includes(`.desktop-icon[data-id="documents"]').dispatchEvent(new MouseEvent('dblclick'`)) return 'bureau';
      if (script.includes(`exButton('Actualiser').click()`)) return 'actualiser';
      if (script.includes(`.ex-side[data-id="place:desktop"]').click()`)) return 'autre dossier';
      return null;
    })
    .filter(Boolean);
  assert.deepEqual(gestures, ['explorateur', 'tuile', 'précédent', 'volet', 'bureau', 'ce pc', 'bureau', 'actualiser', 'autre dossier']);

  // Le message attendu est contrôlé après chacun des trois chemins — deux fois pour l'icône du bureau —, puis après l'actualisation.
  const expectations = executed.filter((script) => script.includes('return missing();') || script.includes('const shown = missing();'));
  assert.ok(expectations.length >= 5, String(expectations.length));
  // Icône du bureau : une seule fenêtre quand elle affiche déjà le dossier ; deux, dont l'autre restée sur « Ce PC », sinon.
  assert.equal(expectations.filter((script) => script.includes(`windows === 1 && exWin().classList.contains('is-focused')`)).length, 1);
  assert.equal(expectations.filter((script) => script.includes(`windows.length === 2 && exWin().classList.contains('is-focused') && others.join() === 'pc'`)).length, 1);
  for (const script of expectations) {
    assert.ok(script.includes(JSON.stringify(documentsTest.MESSAGE_TITLE)) && script.includes(JSON.stringify(documentsTest.NOTHING_CREATED)));
    assert.match(script, /state\.code === 'place-unavailable'/);
    assert.match(script, /exItems\(\)\.length === 0/);
  }

  // Le scénario lui-même n'écrit rien : il ne demande au service que des emplacements et le contenu des autres dossiers.
  const calls = executed.flatMap((script) => [...script.matchAll(/\bfiles\('(\w+)'|services\.call\('files', '(\w+)'/g)].map((match) => match[1] ?? match[2]));
  assert.deepEqual([...new Set(calls)].sort(), ['list', 'places']);
  assert.ok(!executed.some((script) => /services\.call\('settings'/.test(script)), 'aucun réglage touché');
  // Seuls les dossiers présents sont consultés — jamais l'emplacement du dossier absent.
  const listed = executed.find((script) => script.includes("files('list', place.path)"));
  assert.ok(listed.includes('"/home/lea/Bureau"') && listed.includes('"/home/lea/Musique"') && !/documents/i.test(listed.slice(listed.indexOf('for (const place of'), listed.indexOf("files('list'"))));
});

test('scénario « documents-missing » : un dossier Documents présent — non mis de côté, ou recréé — fait échouer', async () => {
  const present = { ...WITHOUT_DOCUMENTS, places: WITHOUT_DOCUMENTS.places.map((place) => (place.id === 'documents' ? { id: 'documents', path: '/home/lea/Documents', available: true } : place)) };
  const win = documentsWindow(present);
  const { code, report } = await run(win, FAST, { scenario: 'documents-missing' });
  assert.equal(code, 1);
  assert.deepEqual(failed(report), [documentsTest.CHECKS.absent]);
  assert.deepEqual(report.checks.at(-1).value, { dossier: '/home/lea/Documents' });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /^le dossier Documents existe sur cette machine \(\/home\/lea\/Documents\) : s'il avait été mis de côté avant ce lancement .* c'est qu'il vient d'être recréé/);
  // Le scénario s'arrête là : aucun geste dans l'interface.
  assert.ok(!win.webContents.executed.some((script) => /\.click\(\)|dispatchEvent/.test(script)));
  assert.deepEqual(report.captures, []);
});

test('scénario « documents-missing » : seule une réponse sans emplacement pour Documents est admise', async () => {
  const withPlace = (documents) => ({ ...WITHOUT_DOCUMENTS, places: WITHOUT_DOCUMENTS.places.map((place) => (place.id === 'documents' ? documents : place)) });
  const unusable = [
    true,
    null,
    'texte',
    { refus: 'forbidden' },
    { places: [], drives: [] },
    { places: WITHOUT_DOCUMENTS.places.filter((place) => place.id !== 'documents'), drives: ['/'] },
    withPlace({ id: 'documents', path: '/home/lea/Documents', available: false }), // chemin connu, bien que signalé indisponible
    withPlace({ id: 'documents', path: null }),
    withPlace({ id: 'documents', path: null, available: 'non' }),
    () => {
      throw new Error('panne');
    },
  ];
  for (const answer of unusable) {
    const win = documentsWindow(answer);
    const { code, report } = await run(win, FAST, { scenario: 'documents-missing' });
    assert.equal(code, 1, JSON.stringify(answer));
    assert.deepEqual(failed(report), [documentsTest.CHECKS.absent], JSON.stringify(answer));
    assert.equal(report.checks.length, 2, 'le scénario s’arrête à ce constat');
    assert.ok(!win.webContents.executed.some((script) => /\.click\(\)|dispatchEvent/.test(script)));
  }
});

test('scénario « documents-missing » : un dossier affiché à la place du message fait échouer, valeur observée à l’appui', async () => {
  // L'explorateur affiche un dossier (vide) au lieu du message : exactement ce que donnerait un dossier recréé.
  const observed = { page: 'folder', path: '/home/lea/Documents', message: 'Ce dossier est vide', elements: [], texte: null, fil: ['Ce PC', 'Documents'] };
  const win = documentsWindow(WITHOUT_DOCUMENTS, (script) => (script.includes('return missing();') || script.includes('const shown = missing();') ? observed : true));
  const { code, report } = await run(win, FAST, { scenario: 'documents-missing' });
  assert.equal(code, 1);
  assert.deepEqual(failed(report), [documentsTest.CHECKS.tile, documentsTest.CHECKS.sidebar, documentsTest.CHECKS.desktop, documentsTest.CHECKS.refresh]);
  assert.deepEqual(report.checks.find((item) => !item.ok).value, observed);
  // Icône du bureau : l'étape en défaut est nommée, avec ce que l'explorateur affichait.
  assert.deepEqual(report.checks.find((item) => item.name === documentsTest.CHECKS.desktop).value, { etape: 'une fenêtre affiche déjà ce dossier', obtenu: observed });
  // Les autres contrôles ont tout de même été menés.
  assert.equal(report.checks.length, DOCUMENTS_CHECKS.length);
});

test('scénario « documents-missing » : sans autre dossier personnel, un avertissement remplace le dernier contrôle', async () => {
  const alone = { places: WITHOUT_DOCUMENTS.places.map((place) => ({ id: place.id, path: null, available: false })), drives: [] };
  const win = documentsWindow(alone);
  const { code, report } = await run(win, FAST, { scenario: 'documents-missing' });
  assert.equal(code, 0, JSON.stringify(report.checks));
  assert.deepEqual(report.checks.map((item) => item.name), DOCUMENTS_CHECKS.slice(0, -1));
  assert.deepEqual(report.warnings, ['aucun autre dossier personnel sur cette machine : leur consultation n’a pas été vérifiée']);
  assert.ok(!win.webContents.executed.some((script) => script.includes("files('list'")));
  assert.deepEqual(report.explorer, { places: [], drives: [] });
});

