/**
 * Auto-test de l'application (src/main/selftest.js), exécuté ici contre une
 * fausse fenêtre : on vérifie qu'il ne conclut à une réussite que lorsque
 * tout est conforme, et qu'il ne reste jamais bloqué.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';

import { fromRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { runSelfTest, countColors, DEFAULT_TIMINGS, DEFAULT_SCENARIO, MIN_CAPTURE_COLORS, WALLPAPER } = require('../src/main/selftest.js');
const { CHANGED_SETTINGS, EXPECTED_SETTINGS } = require('../src/main/selftest-settings.js');
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

/** Lance l'auto-test et renvoie son code de sortie et son rapport. */
async function run(win, timings = FAST, options = {}) {
  const outDir = freshDir();
  const code = await runSelfTest(win, { outDir, timings, ...options });
  const report = JSON.parse(readFileSync(path.join(outDir, 'result.json'), 'utf8'));
  return { code, report, outDir };
}

const failed = (report) => report.checks.filter((item) => !item.ok).map((item) => item.name);

test('tout est conforme : code 0, rapport complet, sept captures', async () => {
  const win = createWindow();
  const { code, report, outDir } = await run(win);

  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.equal(report.scenario, 'full');
  assert.equal(DEFAULT_SCENARIO, 'full');
  assert.equal(report.services, null, "sans état des services fourni, le rapport n'en invente pas");
  assert.equal(report.checks.length, 24);
  assert.deepEqual(failed(report), []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.window, { width: 1600, height: 900 });
  assert.equal(report.versions.node, process.versions.node);
  assert.equal(report.executable, process.execPath);
  assert.ok(report.durationMs >= 0);
  assert.equal(new Set(report.checks.map((item) => item.name)).size, 24, 'intitulés tous différents');

  assert.deepEqual(report.captures, [
    '01-bureau.png',
    '02-menu-demarrer.png',
    '03-recherche.png',
    '04-parametres-rapides.png',
    '05-notifications.png',
    '06-explorateur.png',
    '07-fenetres.png',
  ]);
  assert.deepEqual(readdirSync(outDir).sort(), [...report.captures, 'result.json'].sort());
  assert.deepEqual(
    report.images,
    report.captures.map((file) => ({ file, width: 80, height: 45, colors: 300 })),
  );
  assert.equal(win.showCalls, 1, 'la fenêtre est affichée pour le test');
});

test('le code exécuté dans la page est du JavaScript valide', async () => {
  const win = createWindow();
  await run(win);
  assert.ok(win.webContents.executed.length >= 30);
  for (const code of win.webContents.executed) {
    assert.doesNotThrow(() => new vm.Script(code), `code invalide : ${code.slice(0, 120)}…`);
    assert.match(code, /^\(async \(\) => \{[\s\S]*\}\)\(\)$/);
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
  assert.equal(report.checks.length, 24);
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
    assert.equal(report.checks.length, 23);
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
  assert.equal(first.report.checks.length, 23);
  assert.deepEqual(first.report.captures, []);
  assert.equal(first.report.warnings.length, 7);
  assert.match(first.report.warnings[0], /capture « 01-bureau » impossible : fenêtre masquée/);

  const empty = createWindow(() => true, { capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) });
  const second = await run(empty);
  assert.equal(second.code, 0);
  assert.deepEqual(second.report.captures, []);
  assert.match(second.report.warnings[0], /capture « 01-bureau » vide/);
  assert.deepEqual(readdirSync(second.outDir), ['result.json']);

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
// Services et scénarios
// ---------------------------------------------------------------------------------

test('le contrôle complet vérifie que la page joint les services et que ceux-ci refusent une demande invalide', async () => {
  const { report } = await run(createWindow());
  const name = "services d'Evolve joignables depuis l'interface (réglages)";
  assert.ok(report.checks.some((item) => item.name === name && item.ok));

  // Passerelle sans services (ancienne version) : le contrôle échoue, seul.
  const win = createWindow((code) => (code.includes('window.evolve.services') ? { values: undefined } : true));
  const broken = await run(win);
  assert.equal(broken.code, 1);
  assert.deepEqual(failed(broken.report), [name]);
});

test('l’état des services est joint au rapport ; son absence est un simple avertissement', async () => {
  const described = { settings: { state: 'available', storage: 'memory', file: null } };
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
