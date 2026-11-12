/**
 * Auto-test de l'application (src/main/selftest.js), exécuté ici contre une
 * fausse fenêtre : on vérifie qu'il ne conclut à une réussite que lorsque
 * tout est conforme, et qu'il ne reste jamais bloqué.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';

import { fromRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { runSelfTest, countColors, DEFAULT_TIMINGS, DEFAULT_SCENARIO, MIN_CAPTURE_COLORS, WALLPAPER } = require('../src/main/selftest.js');
const { CHANGED_SETTINGS, EXPECTED_SETTINGS } = require('../src/main/selftest-settings.js');
const documentsTest = require('../src/main/selftest-documents.js');
const explorerTest = require('../src/main/selftest-explorer.js');
const { SETTINGS, defaultsOf } = require('../src/services/settings-schema.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-selftest-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Durées très courtes : les tests ne patientent pas. */
const FAST = { total: 5_000, ready: 80, check: 80, response: 1_000, poll: 5, settle: 0 };

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

/**
 * Fausse fenêtre d'application.
 * @param {(code: string, webContents: EventEmitter) => unknown} [answer]  réponse de la page au code exécuté
 */
function createWindow(answer = () => true, { capturePage } = {}) {
  const webContents = new EventEmitter();
  webContents.executed = [];
  webContents.executeJavaScript = async (code) => {
    webContents.executed.push(code);
    return answer(code, webContents);
  };
  return {
    webContents,
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
  const code = await runSelfTest(win, { timings, platform: 'linux', ...options, outDir });
  const report = JSON.parse(readFileSync(path.join(outDir, 'result.json'), 'utf8'));
  return { code, report, outDir };
}

/** Nombre de contrôles du scénario complet ; un de plus sous Windows (dossier protégé). */
const FULL_CHECKS = 43;

const failed = (report) => report.checks.filter((item) => !item.ok).map((item) => item.name);

test('tout est conforme : code 0, rapport complet, sept captures', async () => {
  const win = createWindow();
  const { code, report, outDir } = await run(win);

  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.equal(report.scenario, 'full');
  assert.equal(DEFAULT_SCENARIO, 'full');
  assert.equal(report.services, null, "sans état des services fourni, le rapport n'en invente pas");
  assert.equal(report.checks.length, FULL_CHECKS);
  assert.equal(report.explorer, null, "sans réponse du service de fichiers, le rapport n'invente aucun emplacement");
  assert.deepEqual(failed(report), []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.window, { width: 1600, height: 900 });
  assert.equal(report.versions.node, process.versions.node);
  assert.equal(report.executable, process.execPath);
  assert.ok(report.durationMs >= 0);
  assert.equal(new Set(report.checks.map((item) => item.name)).size, FULL_CHECKS, 'intitulés tous différents');

  assert.deepEqual(report.captures, [
    '01-bureau.png',
    '02-menu-demarrer.png',
    '03-recherche.png',
    '04-parametres-rapides.png',
    '05-notifications.png',
    '06-explorateur.png',
    '07-fenetres.png',
  ]);
  // À côté du rapport et des captures : le dossier d'essai parcouru par l'explorateur.
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
  assert.equal(report.captures.length, 7);
});

test('seule la valeur `true` est une réussite', async () => {
  for (const value of [false, null, undefined, 1, 'true', {}, []]) {
    const win = createWindow((code) => (code.includes('.desktop-icon') ? value : true));
    const { code, report } = await run(win);
    assert.equal(code, 1, `valeur ${JSON.stringify(value)}`);
    assert.deepEqual(failed(report), ['icônes du bureau']);
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
  assert.equal(report.captures.length, 7, 'les captures sont tout de même enregistrées');

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
    assert.equal(report.captures.length, 7);
    assert.deepEqual(report.warnings, []);
  }
});

test('captures impossibles ou vides : simples avertissements, le test reste valable', async () => {
  const failing = createWindow(() => true, { capturePage: async () => Promise.reject(new Error('fenêtre masquée')) });
  const first = await run(failing);
  assert.equal(first.code, 0);
  assert.equal(first.report.checks.length, FULL_CHECKS - 1);
  assert.deepEqual(first.report.captures, []);
  assert.equal(first.report.warnings.length, 7);
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
// Explorateur de fichiers : vrais dossiers, lecture seule
// ---------------------------------------------------------------------------------

/** Intitulés des contrôles de l'explorateur, dans l'ordre du scénario. */
const EXPLORER_CHECKS = [
  "l'explorateur consulte les vrais dossiers, en lecture seule (aucun contenu d'exemple)",
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
  '« Réseau » et « Corbeille » sont annoncés comme non disponibles, sans contenu fictif',
  'le service de fichiers refuse les chemins relatifs, réseau ou spéciaux, et distingue dossier introuvable et fichier',
  "le service de fichiers n'offre que la consultation : aucune opération d'écriture n'existe",
  "l'explorateur n'a rien modifié dans le dossier parcouru (contenu, tailles et dates identiques)",
];
const PROTECTED_CHECK = 'un dossier protégé de Windows affiche « Accès refusé », sans bloquer la navigation';
const UNCHANGED_CHECK = EXPLORER_CHECKS.at(-1);
const READ_ONLY_CHECK = EXPLORER_CHECKS.at(-2);

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

test('explorateur : un service de fichiers qui sait écrire fait échouer l’auto-test', async () => {
  const described = (methods) => () => ({ settings: {}, files: { state: 'available', access: 'read-only', methods, events: [] } });

  const sound = await run(createWindow(), FAST, { describeServices: described(['places', 'list']) });
  assert.equal(sound.code, 0);

  // Méthode supplémentaire annoncée par le service.
  for (const methods of [['places', 'list', 'write'], ['list', 'places'], ['places'], [], undefined]) {
    const { code, report } = await run(createWindow(), FAST, { describeServices: described(methods) });
    assert.equal(code, 1, JSON.stringify(methods));
    assert.deepEqual(failed(report), [READ_ONLY_CHECK]);
    assert.deepEqual(report.checks.find((item) => !item.ok).value, { methodes: methods ?? [], demandes: true });
  }

  // Demande d'écriture acceptée par la page.
  const accepted = [{ method: 'delete', obtenu: 'accepté' }];
  const win = createWindow((code) => (code.includes("code !== 'unknown-method'") ? accepted : true));
  const { code, report } = await run(win, FAST, { describeServices: described(['places', 'list']) });
  assert.equal(code, 1);
  assert.deepEqual(failed(report), [READ_ONLY_CHECK]);
  assert.deepEqual(report.checks.find((item) => !item.ok).value, { methodes: ['places', 'list'], demandes: accepted });

  // Chaque opération d'écriture, de suppression ou d'ouverture est tentée depuis la page.
  const attempts = win.webContents.executed.find((script) => script.includes("code !== 'unknown-method'"));
  for (const method of ['write', 'create', 'mkdir', 'rename', 'move', 'copy', 'delete', 'remove', 'trash', 'open', 'read']) {
    assert.ok(attempts.includes(`"${method}"`), method);
  }
  assert.deepEqual([...explorerTest.WRITE_METHODS].sort(), ['copy', 'create', 'delete', 'mkdir', 'move', 'open', 'read', 'remove', 'rename', 'trash', 'write']);
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
  assert.equal(report.checks.length, FULL_CHECKS + 1);
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
  assert.equal(second.report.checks.length, FULL_CHECKS + 1);
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
    assert.equal(skipped.report.checks.length, FULL_CHECKS);
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
  // Les contrôles qui précèdent le dossier d'essai ont eu lieu, ceux des fenêtres aussi.
  assert.ok(names.includes(EXPLORER_CHECKS[2]));
  assert.ok(!names.includes(EXPLORER_CHECKS[4]));
  assert.ok(names.includes('les fenêtres se ferment'));
  assert.equal(report.captures.includes('06-explorateur.png'), false);
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
  assert.deepEqual(EXPECTED_SETTINGS, { ...defaults, ...CHANGED_SETTINGS });
  assert.deepEqual(Object.keys(EXPECTED_SETTINGS), Object.keys(SETTINGS));
});

test('scénario « settings-write » : réglages modifiés par des gestes dans l’interface, puis confirmés par le service', async () => {
  const win = createWindow();
  const { code, report, outDir } = await run(win, FAST, { scenario: 'settings-write' });
  assert.equal(code, 0);
  assert.equal(report.scenario, 'settings-write');
  assert.deepEqual(report.checks.map((item) => item.name), [
    "l'interface a démarré",
    'premier lancement : chaque réglage a sa valeur par défaut',
    'les réglages sont enregistrés dans un fichier',
    "le panneau des paramètres rapides s'ouvre",
    "l'interface affiche les réglages modifiés",
    'le service des réglages a reçu chaque changement',
  ]);
  assert.deepEqual(report.captures, ['01-reglages-modifies.png']);
  assert.deepEqual(readdirSync(outDir).sort(), ['01-reglages-modifies.png', 'result.json']);

  const { executed } = win.webContents;
  for (const script of executed) assert.doesNotThrow(() => new vm.Script(script), `code invalide : ${script.slice(0, 120)}…`);
  // Des gestes d'utilisateur — clics et curseurs — et non des appels directs au service.
  const actions = executed.filter((script) => /\.click\(\)|dispatchEvent/.test(script));
  assert.equal(actions.length, 6);
  for (const needle of ['.tb-tray', 'data-setting="nightLight"', 'data-setting="doNotDisturb"', "input.value = '60'", "input.value = '35'", '.tb-widgets']) {
    assert.equal(actions.filter((script) => script.includes(needle)).length, 1, needle);
  }
  assert.ok(!executed.some((script) => /services\.call\('settings', '(?:set|reset)'/.test(script)), 'aucune écriture directe');
});

test('scénario « settings-read » : aucune modification, seulement des constats et l’ouverture du panneau', async () => {
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
  ]);
  assert.deepEqual(report.captures, ['01-reglages-restaures.png']);

  const { executed } = win.webContents;
  for (const script of executed) assert.doesNotThrow(() => new vm.Script(script), `code invalide : ${script.slice(0, 120)}…`);
  assert.ok(!executed.some((script) => /dispatchEvent|\.value = |services\.call\('settings', '(?:set|reset)'/.test(script)), 'aucun réglage touché');
  const clicks = executed.filter((script) => script.includes('.click()'));
  assert.equal(clicks.length, 1);
  assert.match(clicks[0], /\.tb-tray/);
  // Le constat précède toute action : l'ouverture du panneau vient en dernier.
  const firstClick = executed.findIndex((script) => script.includes('.click()'));
  const lastSettingsCheck = executed.findLastIndex((script) => script.includes("services.call('settings', 'state')"));
  assert.ok(firstClick > lastSettingsCheck);
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

  // Les gestes d'un utilisateur, dans l'ordre : explorateur, tuile, précédent, volet, « Ce PC », icône du bureau, actualiser, autre dossier.
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
  assert.deepEqual(gestures, ['explorateur', 'tuile', 'précédent', 'volet', 'ce pc', 'bureau', 'actualiser', 'autre dossier']);

  // Le message attendu est contrôlé après chacun des trois chemins, puis après l'actualisation.
  const expectations = executed.filter((script) => script.includes('return missing();') || script.includes('const shown = missing();'));
  assert.ok(expectations.length >= 4, String(expectations.length));
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

