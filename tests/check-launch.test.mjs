/**
 * Vérification du lancement normal de l'exécutable (scripts/check-launch.mjs).
 * Une fausse application (tests/fixtures/fake-launch-app.mjs) imite les
 * comportements possibles : le script ne doit conclure à un lancement conforme
 * que si TOUT l'est (démarrage, plein écran, fermeture, nettoyage).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

import {
  colorGrid,
  decodePng,
  folderUsage,
  formatSize,
  gridMatch,
  launcherDirs,
  main,
  parseCaptureInfo,
  SCREEN_MATCH,
  screenReport,
  statusProblems,
} from '../scripts/check-launch.mjs';
import { fromRoot } from './helpers.mjs';

const SCRIPT = fromRoot('scripts', 'check-launch.mjs');
const FAKE_APP = fromRoot('tests', 'fixtures', 'fake-launch-app.mjs');
const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-check-launch-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** État signalé par une application correctement démarrée, en plein écran. */
const healthy = (changes = {}) => ({
  ready: true,
  closed: false,
  visible: true,
  fullscreen: true,
  minimized: false,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  display: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
  errors: [],
  ...changes,
});

// --- État de la fenêtre ------------------------------------------------------------

test('état conforme : aucune anomalie', () => {
  assert.deepEqual(statusProblems(healthy()), []);
  // Une fenêtre plus grande que l'écran (bordures invisibles) reste conforme.
  assert.deepEqual(statusProblems(healthy({ bounds: { x: -8, y: -8, width: 1936, height: 1096 } })), []);
});

test('anomalies de démarrage et d’affichage', () => {
  assert.match(statusProblems(healthy({ ready: false }))[0], /n'a pas démarré/);
  assert.match(statusProblems(healthy({ ready: 'true' }))[0], /n'a pas démarré/, 'seule la valeur true compte');
  assert.match(statusProblems(healthy({ visible: false }))[0], /n'est pas visible/);
  assert.match(statusProblems(healthy({ minimized: true }))[0], /réduite/);
  assert.match(statusProblems(healthy({ fullscreen: false }))[0], /n'est pas en plein écran/);
  assert.match(statusProblems(healthy({ bounds: { x: 0, y: 0, width: 1600, height: 900 } }))[0], /\(1600 × 900\) ne couvre pas l'écran \(1920 × 1080\)/);
  assert.match(statusProblems(healthy({ bounds: null }))[0], /dimensions .* absentes/);
  assert.match(statusProblems(healthy({ display: { width: 'x' } }))[0], /dimensions .* absentes/);
  assert.deepEqual(statusProblems(healthy({ errors: ['console : boum'] })), ["erreur de l'interface : console : boum"]);
});

test('fenêtre fermée pendant le démarrage : anomalies signalées sans détail superflu', () => {
  const problems = statusProblems({ ready: false, closed: true, visible: false, bounds: null, display: null, errors: [] });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /s'est fermée pendant le démarrage/);
  assert.match(problems[1], /n'a pas démarré/);
});

test('plusieurs anomalies sont toutes signalées', () => {
  const problems = statusProblems(healthy({ ready: false, visible: false, fullscreen: false, errors: ['a', 'b'] }));
  assert.equal(problems.length, 5);
});

test('mode fenêtré demandé : le plein écran devient l’anomalie', () => {
  const windowed = healthy({ fullscreen: false, bounds: { x: 160, y: 90, width: 1600, height: 900 } });
  assert.deepEqual(statusProblems(windowed, { expectFullscreen: false }), []);
  assert.match(statusProblems(healthy(), { expectFullscreen: false })[0], /plein écran alors que le mode fenêtré/);
});

test('compte rendu illisible', () => {
  for (const value of [null, undefined, 'texte', 42]) {
    assert.deepEqual(statusProblems(value), ["compte rendu de l'application illisible"]);
  }
});

// --- Lecture des images PNG ------------------------------------------------------------

/** Morceau d'un fichier PNG : longueur, type, contenu, somme de contrôle. */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * Image PNG dont la couleur de chaque point est donnée par `color(x, y)` → [r, v, b].
 * @param {{ alpha?: boolean, filter?: 0|1|2|3|4|'mixte', pieces?: number, header?: object }} [options]
 *   `filter` : filtre appliqué à chaque ligne ; `pieces` : nombre de morceaux de données
 */
function png(width, height, color, { alpha = false, filter = 0, pieces = 1, header = {} } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = color(x, y);
      pixels.set(alpha ? [r, g, b, 255] : [r, g, b], y * stride + x * channels);
    }
  }

  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const kind = filter === 'mixte' ? y % 5 : filter;
    raw[y * (stride + 1)] = kind;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const paeth = () => {
        const [pa, pb, pc] = [Math.abs(b - c), Math.abs(a - c), Math.abs(a + b - 2 * c)];
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      };
      const predicted = [0, a, b, (a + b) >> 1, kind === 4 ? paeth() : 0][kind];
      raw[y * (stride + 1) + 1 + x] = (pixels[y * stride + x] - predicted) & 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([header.depth ?? 8, header.colorType ?? (alpha ? 6 : 2), 0, 0, header.interlace ?? 0], 8);

  const data = deflateSync(raw);
  const size = Math.ceil(data.length / pieces);
  const idat = Array.from({ length: pieces }, (_unused, index) => chunk('IDAT', data.subarray(index * size, (index + 1) * size)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0morceau ignoré', 'latin1')),
    ...idat,
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pattern = (x, y) => [(x * 7 + y * 3) % 256, (x * x + y) % 256, (x + y * 11) % 256];

test('image PNG : tous les filtres de ligne, avec ou sans transparence', () => {
  const expected = decodePng(png(37, 23, pattern));
  assert.equal(expected.width, 37);
  assert.equal(expected.height, 23);
  assert.equal(expected.channels, 3);
  assert.deepEqual([...expected.pixels.subarray(0, 6)], [...pattern(0, 0), ...pattern(1, 0)]);
  assert.deepEqual([...expected.pixels.subarray((22 * 37 + 36) * 3)], pattern(36, 22));

  for (const filter of [1, 2, 3, 4, 'mixte']) {
    const decoded = decodePng(png(37, 23, pattern, { filter }));
    assert.ok(decoded.pixels.equals(expected.pixels), `filtre ${filter}`);
  }

  for (const filter of [0, 1, 2, 3, 4, 'mixte']) {
    const decoded = decodePng(png(37, 23, pattern, { alpha: true, filter }));
    assert.equal(decoded.channels, 4);
    for (const [x, y] of [[0, 0], [36, 0], [0, 22], [36, 22], [17, 11]]) {
      assert.deepEqual([...decoded.pixels.subarray((y * 37 + x) * 4, (y * 37 + x) * 4 + 4)], [...pattern(x, y), 255], `filtre ${filter}, point ${x},${y}`);
    }
  }

  // Données réparties en plusieurs morceaux, comme dans les grandes images.
  assert.ok(decodePng(png(37, 23, pattern, { filter: 'mixte', pieces: 5 })).pixels.equals(expected.pixels));
});

test('image PNG : fichiers réels du projet lus à l’identique', () => {
  // Empreinte des points du fond d'écran officiel, calculée avec un autre logiciel (ImageMagick).
  const wallpaper = decodePng(readFileSync(fromRoot('assets', 'wallpapers', 'panorama-cosmique-violet-sur-lac-miroir.png')));
  assert.deepEqual([wallpaper.width, wallpaper.height, wallpaper.channels], [1672, 941, 3]);
  assert.equal(sha256(wallpaper.pixels), 'edcd6542be15bb5cf0ebeeb87846e442743024265c47ab24365b560347d7417c');

  // Image avec transparence : coin transparent, centre opaque.
  const icon = decodePng(readFileSync(fromRoot('assets', 'icons', 'evolve-256.png')));
  assert.deepEqual([icon.width, icon.height, icon.channels], [256, 256, 4]);
  assert.equal(icon.pixels[3], 0);
  assert.equal(icon.pixels[(128 * 256 + 128) * 4 + 3], 255);
});

test('image PNG : fichiers invalides ou non pris en charge refusés', () => {
  assert.throws(() => decodePng(Buffer.from('BM, pas une image PNG')), /n'est pas une image PNG/);
  assert.throws(() => decodePng(Buffer.alloc(0)), /n'est pas une image PNG/);

  const valid = png(8, 8, pattern);
  assert.throws(() => decodePng(valid.subarray(0, 8)), /sans en-tête/);
  assert.throws(() => decodePng(valid.subarray(0, 60)), /tronquée/);
  assert.throws(() => decodePng(png(8, 8, pattern, { header: { depth: 16 } })), /non pris en charge \(16 bits, type 2\)/);
  assert.throws(() => decodePng(png(8, 8, pattern, { header: { colorType: 3 } })), /non pris en charge \(8 bits, type 3\)/);
  assert.throws(() => decodePng(png(8, 8, pattern, { header: { interlace: 1 } })), /entrelacé/);

  // Données compressées abîmées.
  const corrupted = Buffer.from(valid);
  corrupted.fill(0xff, valid.indexOf('IDAT') + 4, valid.indexOf('IEND') - 8);
  assert.throws(() => decodePng(corrupted), /illisible/);

  // Moins de lignes que n'en annonce l'en-tête.
  const short = Buffer.from(valid);
  short.writeUInt32BE(64, 20);
  assert.throws(() => decodePng(short), /tronquée/);

  // Filtre de ligne inconnu.
  assert.throws(() => decodePng(png(8, 8, pattern, { filter: 7 })), /filtre 7/);
});

// --- Comparaison de l'écran avec l'image dessinée par l'application --------------------

/** Image d'essai rappelant le bureau : dégradé violet, bande claire, barre sombre en bas. */
const desktop = (width, height) => (x, y) => {
  if (y >= height * 0.94) return [18, 12, 28];
  if (Math.abs(y - height * 0.55) < height * 0.04) return [235, 200, 250];
  return [40 + Math.round((120 * x) / width), 20, 90 + Math.round((100 * y) / height)];
};

test('grille de couleurs : moyenne de chaque case', () => {
  const image = decodePng(png(8, 4, (x, y) => (x < 4 ? [200, 100, 0] : [0, y < 2 ? 50 : 150, 250])));
  assert.deepEqual(colorGrid(image, 2, 1), [
    [200, 100, 0],
    [0, 100, 250],
  ]);
  assert.deepEqual(colorGrid(image, 2, 2), [
    [200, 100, 0],
    [0, 50, 250],
    [200, 100, 0],
    [0, 150, 250],
  ]);
  // Transparence ignorée ; image plus petite que la grille : aucune case vide.
  assert.deepEqual(colorGrid(decodePng(png(8, 4, () => [9, 8, 7], { alpha: true })), 2, 2), Array(4).fill([9, 8, 7]));
  const tiny = colorGrid(decodePng(png(3, 2, () => [1, 2, 3])));
  assert.equal(tiny.length, 32 * 18);
  assert.ok(tiny.every((cell) => cell.join() === '1,2,3'));
});

test('grilles comparées : part des cases identiques, à une tolérance près', () => {
  const grid = [[10, 10, 10], [100, 100, 100], [200, 200, 200], [50, 60, 70]];
  assert.equal(gridMatch(grid, grid), 1);
  assert.equal(gridMatch(grid, [[10, 10, 26], [100, 100, 100], [200, 200, 200], [50, 60, 70]]), 1, 'écart toléré');
  assert.equal(gridMatch(grid, [[10, 10, 27], [100, 100, 100], [200, 200, 200], [50, 60, 70]]), 0.75, 'une seule composante suffit à distinguer');
  assert.equal(gridMatch(grid, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 0.25);
  assert.equal(gridMatch(grid, grid.slice(1)), 0, 'grilles de tailles différentes');
  assert.equal(gridMatch([], []), 0);
});

test('écran identique à l’image dessinée : interface affichée', () => {
  const render = png(640, 360, desktop(640, 360));
  const same = screenReport(render, render);
  assert.equal(same.level, 'pass');
  assert.equal(same.ratio, 1);
  assert.equal(same.text, "l'écran affiche l'interface : 100 % de l'écran (640 × 360) correspond à l'image dessinée par l'application");

  // Écran d'une autre définition (affichage agrandi) ou enregistré avec transparence : même verdict.
  assert.equal(screenReport(png(960, 540, desktop(960, 540), { alpha: true, filter: 4 }), render).level, 'pass');
});

test('écran partiellement différent : barre des tâches tolérée, fenêtre par-dessus signalée', () => {
  const render = png(640, 360, desktop(640, 360));
  const base = desktop(640, 360);

  // Barre des tâches de Windows restée visible en bas de l'écran.
  const taskbar = screenReport(png(640, 360, (x, y) => (y >= 344 ? [200, 200, 200] : base(x, y))), render);
  assert.equal(taskbar.level, 'pass');
  assert.ok(taskbar.ratio < 1 && taskbar.ratio >= SCREEN_MATCH.shown);

  // Fenêtre d'un autre programme couvrant un quart de l'écran.
  const covered = screenReport(png(640, 360, (x, y) => (x >= 100 && x < 420 && y >= 60 && y < 240 ? [12, 12, 12] : base(x, y))), render);
  assert.equal(covered.level, 'warn');
  assert.match(covered.text, /^l'écran n'affiche l'interface qu'en partie : 7\d % de l'écran \(640 × 360\)/);
  assert.match(covered.text, /une autre fenêtre la recouvre peut-être/);
});

/** Écrans sans rapport avec l'image dessinée par l'application. */
const unrelatedScreens = {
  noir: () => [0, 0, 0],
  blanc: () => [255, 255, 255],
  'bleu Windows': () => [0, 120, 215],
  // Capture tronquée : seul le coin supérieur gauche de l'écran, agrandi.
  tronqué: (x, y) => desktop(640, 360)(Math.floor(x / 1.5), Math.floor(y / 1.5)),
};

test('écran sans rapport avec l’image dessinée, fenêtre au premier plan : échec', () => {
  const render = png(640, 360, desktop(640, 360));
  for (const [name, color] of Object.entries(unrelatedScreens)) {
    const report = screenReport(png(640, 360, color), render, { foreground: true });
    assert.equal(report.level, 'fail', name);
    assert.ok(report.ratio < SCREEN_MATCH.absent, name);
    assert.match(report.text, /^l'écran n'affiche pas l'interface alors que sa fenêtre est au premier plan : \d+ % de l'écran \(640 × 360\) seulement/, name);
  }
  const black = screenReport(png(640, 360, () => [0, 0, 0]), render, { foreground: true });
  assert.match(black.text, /couleur moyenne de l'écran : rvb\(0, 0, 0\) ; de l'interface : rvb\(\d+, \d+, \d+\)/);
});

test('écran sans rapport avec l’image dessinée, autre fenêtre au premier plan : non concluant', () => {
  // Une autre fenêtre de la machine recouvre l'application : cela ne dit rien d'elle.
  const render = png(640, 360, desktop(640, 360));
  const black = png(640, 360, () => [0, 0, 0]);

  const behind = screenReport(black, render, { foreground: false });
  assert.equal(behind.level, 'warn');
  assert.match(behind.text, /^l'écran ne montre pas l'interface \(\d+ % de l'écran \(640 × 360\) seulement/);
  assert.match(behind.text, /la fenêtre de l'application n'est pas au premier plan sur cette machine : l'affichage n'a pas pu être confirmé/);

  for (const unknown of [screenReport(black, render), screenReport(black, render, { foreground: null })]) {
    assert.equal(unknown.level, 'warn');
    assert.match(unknown.text, /la fenêtre au premier plan n'a pas pu être identifiée : l'affichage n'a pas pu être confirmé/);
  }

  // Le premier plan ne change rien aux autres verdicts.
  assert.equal(screenReport(render, render, { foreground: false }).level, 'pass');
  const base = desktop(640, 360);
  const covered = png(640, 360, (x, y) => (x >= 100 && x < 420 && y >= 60 && y < 240 ? [12, 12, 12] : base(x, y)));
  assert.equal(screenReport(covered, render, { foreground: true }).level, 'warn');
});

test('capture d’une autre taille que l’écran : jamais comparée', () => {
  const render = png(640, 360, desktop(640, 360));
  // Affichage de Windows agrandi : capture limitée au coin supérieur gauche.
  const cropped = screenReport(png(427, 240, () => [0, 0, 0]), render, { foreground: true, expected: { width: 640, height: 360 } });
  assert.equal(cropped.level, 'warn');
  assert.equal(cropped.ratio, null);
  assert.equal(
    cropped.text,
    "capture de l'écran aux dimensions inattendues (427 × 240 au lieu de 640 × 360) : elle n'a pas été comparée à l'image dessinée par l'application",
  );
  // Deux points d'écart (arrondis) restent admis.
  assert.equal(screenReport(png(640, 360, desktop(640, 360)), render, { expected: { width: 641, height: 358 } }).level, 'pass');
  assert.equal(screenReport(png(640, 360, desktop(640, 360)), render, { expected: { width: 643, height: 360 } }).level, 'warn');
});

test('relevé de la capture : fenêtre au premier plan, erreur', () => {
  assert.deepEqual(parseCaptureInfo('foregroundPid=4242\r\nforegroundTitle=Evolve\r\ncaptured=1920x1080\r\n'), {
    error: '',
    foregroundPid: 4242,
    foregroundTitle: 'Evolve',
  });
  // Titre contenant le séparateur ; aucune fenêtre au premier plan ; relevé impossible.
  assert.equal(parseCaptureInfo('foregroundPid=7\nforegroundTitle=a=b : c\n').foregroundTitle, 'a=b : c');
  assert.deepEqual(parseCaptureInfo('foregroundPid=0\ncaptured=1024x768\n'), { error: '', foregroundPid: 0, foregroundTitle: '' });
  assert.deepEqual(parseCaptureInfo('foregroundError=Type introuvable\ncaptured=1024x768\n'), { error: '', foregroundPid: null, foregroundTitle: '' });
  assert.deepEqual(parseCaptureInfo('foregroundPid=12\nerror=The handle is invalid\n'), {
    error: 'The handle is invalid',
    foregroundPid: 12,
    foregroundTitle: '',
  });
  for (const text of ['', undefined, 'n’importe quoi', 'foregroundPid=abc', 'foregroundPid=-3', 'foregroundPid=1.5', 'foregroundPid=']) {
    assert.equal(parseCaptureInfo(text).foregroundPid, null, JSON.stringify(text));
  }
});

test('seuils de comparaison cohérents', () => {
  assert.ok(Object.isFrozen(SCREEN_MATCH));
  assert.ok(SCREEN_MATCH.absent > 0.25 && SCREEN_MATCH.absent < SCREEN_MATCH.shown && SCREEN_MATCH.shown < 1);
});

test('image illisible : la comparaison le signale par une erreur', () => {
  const render = png(64, 36, desktop(64, 36));
  assert.throws(() => screenReport(Buffer.from('rien'), render), /n'est pas une image PNG/);
  assert.throws(() => screenReport(render, Buffer.from('rien')), /n'est pas une image PNG/);
});

// --- Fichiers temporaires --------------------------------------------------------------

test('dossier temporaire : dossiers de travail du lanceur reconnus à leur nom', () => {
  const tempDir = path.join(workDir, 'noms');
  for (const name of ['nsA1B2.tmp', 'ns7.tmp', 'NSF00D.TMP', 'nsXYZ.tmp', 'ns.tmp', 'nsA1B2.tmp.old', 'autre', 'xnsA1B2.tmp']) {
    mkdirSync(path.join(tempDir, name), { recursive: true });
  }
  writeFileSync(path.join(tempDir, 'nsBEEF.tmp'), 'un fichier, pas un dossier');

  const found = launcherDirs(tempDir).map((dir) => path.basename(dir)).sort();
  assert.deepEqual(found, ['NSF00D.TMP', 'ns7.tmp', 'nsA1B2.tmp']);
  assert.ok(launcherDirs(tempDir).every((dir) => path.isAbsolute(dir)));
  assert.deepEqual(launcherDirs(path.join(workDir, 'inexistant')), []);
});

test('dossier temporaire : nombre de fichiers et taille, sous-dossiers compris', () => {
  const dir = path.join(workDir, 'taille');
  mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  mkdirSync(path.join(dir, 'vide'));
  writeFileSync(path.join(dir, 'un.bin'), Buffer.alloc(1000));
  writeFileSync(path.join(dir, 'a', 'deux.bin'), Buffer.alloc(2000));
  writeFileSync(path.join(dir, 'a', 'b', 'trois.bin'), Buffer.alloc(3000));
  assert.deepEqual(folderUsage(dir), { files: 3, bytes: 6000 });
  assert.deepEqual(folderUsage(path.join(dir, 'vide')), { files: 0, bytes: 0 });
  assert.deepEqual(folderUsage(path.join(dir, 'inexistant')), { files: 0, bytes: 0 });
});

test('taille lisible', () => {
  assert.equal(formatSize(0), '0 Ko');
  assert.equal(formatSize(1), '1 Ko');
  assert.equal(formatSize(1024), '1 Ko');
  assert.equal(formatSize(1025), '2 Ko');
  assert.equal(formatSize(1024 * 1024 - 1), '1024 Ko');
  assert.equal(formatSize(1024 * 1024), '1 Mo');
  assert.equal(formatSize(290.6 * 1024 * 1024), '291 Mo');
});

// --- Déroulement complet, contre la fausse application --------------------------------
// Sous Windows, la demande de fermeture passe par la fenêtre de l'application :
// la fausse application, sans fenêtre, ne peut pas la recevoir. Le déroulement
// réel y est exercé par la compilation automatique, sur le véritable exécutable.
const posixOnly = { skip: process.platform === 'win32' };

/**
 * Lance le script contre la fausse application dans le mode donné. Chaque essai
 * dispose de son propre dossier temporaire (variable TMPDIR), commun au script
 * et à la fausse application.
 * @param {object} [options]
 * @param {string[]} [options.args] options supplémentaires du script
 * @param {string[]} [options.appArgs] arguments transmis à la fausse application
 * @param {object} [options.env] variables d'environnement supplémentaires
 * @param {(tempDir: string) => object|void} [options.prepare] prépare le dossier temporaire avant le
 *   lancement ; peut renvoyer des modifications de l'état signalé par la fausse application
 */
function run(mode, { args = [], appArgs = [], env = {}, prepare } = {}) {
  const outDir = path.join(workDir, `${mode}-${Math.random().toString(36).slice(2, 8)}`);
  const tempDir = path.join(outDir, 'temp');
  mkdirSync(tempDir, { recursive: true });
  const statusChanges = prepare?.(tempDir);
  const result = spawnSync(
    process.execPath,
    [SCRIPT, process.execPath, `--out=${outDir}`, '--timeout=20', '--close-timeout=20', '--observe=0.1', ...args, '--', FAKE_APP, mode, ...appArgs],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: '',
        GITHUB_ACTIONS: '',
        TMPDIR: tempDir,
        FAKE_STATUS: statusChanges ? JSON.stringify(statusChanges) : '',
        ...env,
      },
      timeout: 90_000,
    },
  );
  return {
    code: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    outDir,
    tempDir,
    unpackDir: path.join(tempDir, 'Evolve-portable'),
    launcherDir: path.join(tempDir, 'nsA1B2.tmp'),
  };
}

/** La fausse application lancée dans `tempDir` est-elle encore en cours d'exécution ? */
async function stillRunning(tempDir) {
  const pid = Number(readFileSync(path.join(tempDir, 'fake-app.pid'), 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0);
  // L'arrêt forcé n'est pas instantané : courte attente.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.kill(pid, 'SIGKILL');
  return true;
}

test('lancement conforme : démarrage, plein écran, fermeture normale, nettoyage', posixOnly, () => {
  const { code, output, outDir, unpackDir, launcherDir } = run('ok');
  assert.equal(code, 0, output);
  assert.match(output, /✔ interface démarrée \(état signalé [\d.]+ s après le lancement\)/);
  assert.match(output, /✔ fenêtre visible, en plein écran : 1920 × 1080 sur un écran de 1920 × 1080/);
  assert.match(output, /✔ fermeture normale en [\d.]+ s \(code de sortie 0\)/);
  assert.match(output, /· espace temporaire occupé pendant le fonctionnement : 3 Mo \(Evolve-portable : 3 Ko ; nsA1B2\.tmp : 3 Mo\)/);
  assert.match(output, /✔ fichiers temporaires supprimés à la fermeture \(Evolve-portable, nsA1B2\.tmp\)/);
  assert.match(output, /! écran non capturé : capture de l'écran disponible sous Windows uniquement/);
  assert.match(output, /✔ Lancement normal conforme\./);
  assert.ok(!output.includes('✖'));
  assert.ok(existsSync(path.join(outDir, 'etat.json')), 'le compte rendu est conservé');
  assert.ok(!existsSync(unpackDir));
  assert.ok(!existsSync(launcherDir));
});

test('mode fenêtré (-- --windowed) : conforme sans plein écran', posixOnly, () => {
  const windowed = run('windowed', { appArgs: ['--windowed'] });
  assert.equal(windowed.code, 0, windowed.output);
  assert.match(windowed.output, /✔ fenêtre visible, en mode fenêtré : 1600 × 900 sur un écran de 1920 × 1080/);

  // La même fenêtre, sans l'option, est une anomalie : un double-clic doit ouvrir en plein écran.
  const unexpected = run('windowed');
  assert.equal(unexpected.code, 1);
  assert.match(unexpected.output, /✖ la fenêtre n'est pas en plein écran/);
});

test('anomalies d’affichage : échec, et l’application est tout de même refermée', posixOnly, () => {
  const cases = {
    'not-ready': /✖ l'interface n'a pas démarré/,
    hidden: /✖ la fenêtre n'est pas visible/,
    small: /✖ la fenêtre \(1600 × 900\) ne couvre pas l'écran \(1920 × 1080\)/,
    'console-error': /✖ erreur de l'interface : console : erreur simulée/,
  };
  for (const [mode, expected] of Object.entries(cases)) {
    const { code, output, unpackDir } = run(mode);
    assert.equal(code, 1, `${mode}\n${output}`);
    assert.match(output, expected, mode);
    assert.match(output, /ne doit pas être distribué/, mode);
    assert.match(output, /✔ fermeture normale/, `${mode} : l'application a été refermée`);
    assert.ok(!existsSync(unpackDir), mode);
  }
});

test('quel que soit le résultat, l’application ne reste jamais ouverte', posixOnly, async () => {
  for (const mode of ['ok', 'hidden', 'bad-exit-code', 'leftover', 'self-exit']) {
    const { tempDir } = run(mode, { args: ['--close-timeout=2'] });
    assert.equal(await stillRunning(tempDir), false, mode);
  }
});

test('l’application se termine avant d’avoir démarré : échec', posixOnly, () => {
  const { code, output } = run('exit-early');
  assert.equal(code, 1);
  assert.match(output, /✖ l'application s'est terminée \(code 1\) avant d'avoir démarré son interface\n/);

  // Sortie sans erreur avant tout démarrage : cas d'une autre instance déjà ouverte.
  const second = run('already-open');
  assert.equal(second.code, 1, 'jamais une réussite');
  assert.match(second.output, /✖ l'application s'est terminée \(code 0\) avant d'avoir démarré son interface — Evolve est peut-être déjà ouvert/);
});

test('l’application ne signale jamais son démarrage : arrêtée dans le délai, échec', posixOnly, async () => {
  const started = Date.now();
  const { code, output, tempDir } = run('never-reports', { args: ['--timeout=1'] });
  assert.equal(code, 1);
  assert.match(output, /✖ l'application n'a pas signalé son démarrage en 1 s : elle a été arrêtée/);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(await stillRunning(tempDir), false, "l'application a réellement été arrêtée");
});

test('compte rendu illisible ou sans numéro de processus : échec, application arrêtée', posixOnly, async () => {
  const garbage = run('garbage');
  assert.equal(garbage.code, 1);
  assert.match(garbage.output, /✖ compte rendu de l'application illisible/);
  assert.equal(await stillRunning(garbage.tempDir), false);

  const noPid = run('no-pid');
  assert.equal(noPid.code, 1);
  assert.match(noPid.output, /✖ le compte rendu n'indique pas le processus de l'application/);
  assert.equal(await stillRunning(noPid.tempDir), false);
});

test('l’application se ferme toute seule : échec', posixOnly, () => {
  // Durée d'observation suffisante pour constater la fermeture spontanée.
  const { code, output } = run('self-exit', { args: ['--observe=1'] });
  assert.equal(code, 1, output);
  assert.match(output, /✖ l'application s'est fermée toute seule \(code 0\)/);
});

test('l’application ignore la demande de fermeture : arrêtée de force, échec', posixOnly, async () => {
  const started = Date.now();
  const { code, output, tempDir } = run('ignores-close', { args: ['--close-timeout=1'] });
  assert.equal(code, 1);
  assert.match(output, /✖ l'application ne s'est pas fermée en 1 s après la demande de fermeture : elle a été arrêtée/);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(await stillRunning(tempDir), false, "l'application a réellement été arrêtée");
});

test('code de sortie anormal à la fermeture : échec', posixOnly, () => {
  const { code, output } = run('bad-exit-code');
  assert.equal(code, 1);
  assert.match(output, /✖ fermeture avec un code de sortie anormal \(code 3\)/);
});

test('fichiers temporaires laissés à la fermeture : signalés, sans bloquer', posixOnly, () => {
  // La suppression dépend du lanceur de l'exécutable portable : un reste est
  // un avertissement, détaillé, et non un échec.
  const both = run('leftover', { args: ['--close-timeout=1'] });
  assert.equal(both.code, 0, both.output);
  assert.match(both.output, /✔ fermeture normale/);
  assert.match(
    both.output,
    /! fichiers temporaires encore présents après la fermeture : \S*Evolve-portable \(2 fichiers, 3 Ko\) ; \S*nsA1B2\.tmp \(2 fichiers, 3 Mo\)/,
  );
  assert.ok(!both.output.includes('fichiers temporaires supprimés'));
  assert.ok(existsSync(both.unpackDir), 'le script ne supprime rien lui-même');

  const launcherOnly = run('leftover-launcher', { args: ['--close-timeout=1'] });
  assert.equal(launcherOnly.code, 0, launcherOnly.output);
  assert.match(launcherOnly.output, /! fichiers temporaires encore présents après la fermeture : \S*nsA1B2\.tmp \(2 fichiers, 3 Mo\)\n/);
  assert.ok(!launcherOnly.output.includes('Evolve-portable ('));
});

test('dossiers de travail antérieurs au lancement : ni mesurés, ni attendus à la fermeture', posixOnly, () => {
  const { code, output, tempDir } = run('ok', {
    prepare: (dir) => {
      // Reste d'un lancement précédent, et dossiers au nom seulement ressemblant.
      mkdirSync(path.join(dir, 'ns0C1D.tmp'));
      writeFileSync(path.join(dir, 'ns0C1D.tmp', 'ancien.bin'), Buffer.alloc(5 * 1024 * 1024));
      mkdirSync(path.join(dir, 'nsXYZ.tmp'));
      mkdirSync(path.join(dir, 'autre.tmp'));
    },
  });
  assert.equal(code, 0, output);
  assert.match(output, /espace temporaire occupé pendant le fonctionnement : 3 Mo \(Evolve-portable : 3 Ko ; nsA1B2\.tmp : 3 Mo\)/);
  assert.match(output, /✔ fichiers temporaires supprimés à la fermeture \(Evolve-portable, nsA1B2\.tmp\)/);
  assert.ok(existsSync(path.join(tempDir, 'ns0C1D.tmp', 'ancien.bin')));
});

test('données conservées par l’application : dossier et taille indiqués', posixOnly, () => {
  let userData;
  const { code, output } = run('ok', {
    prepare: (dir) => {
      userData = path.join(dir, 'Evolve');
      mkdirSync(path.join(userData, 'Cache'), { recursive: true });
      writeFileSync(path.join(userData, 'Preferences'), Buffer.alloc(300));
      writeFileSync(path.join(userData, 'Cache', 'data_0'), Buffer.alloc(2 * 1024 * 1024));
      return { userData };
    },
  });
  assert.equal(code, 0, output);
  assert.match(output, /· données conservées après la fermeture : \S*Evolve \(2 fichiers, 2 Mo\)/);
  // Ce dossier n'est pas un fichier temporaire à supprimer : aucun avertissement.
  assert.ok(!output.includes('encore présents'));
  assert.ok(existsSync(userData));

  // Dossier non indiqué, ou inexistant : rien n'est affiché.
  assert.ok(!run('ok').output.includes('données conservées'));
  const missing = run('ok', { prepare: (dir) => ({ userData: path.join(dir, 'absent') }) });
  assert.equal(missing.code, 0, missing.output);
  assert.ok(!missing.output.includes('données conservées'));
});

test('hors exécutable portable : aucun dossier temporaire à surveiller', posixOnly, () => {
  const { code, output } = run('development');
  assert.equal(code, 0, output);
  assert.ok(!output.includes('espace temporaire'));
  assert.ok(!output.includes('fichiers temporaires'));
  assert.match(output, /✔ fermeture normale/);
});

test('un ancien compte rendu n’est jamais pris pour celui du jour', posixOnly, () => {
  const outDir = path.join(workDir, 'ancien');
  const first = spawnSync(process.execPath, [SCRIPT, process.execPath, `--out=${outDir}`, '--timeout=20', '--observe=0', '--', FAKE_APP, 'ok'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' },
  });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(path.join(outDir, 'etat.json')));

  const second = spawnSync(process.execPath, [SCRIPT, process.execPath, `--out=${outDir}`, '--timeout=1', '--', FAKE_APP, 'never-reports'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' },
  });
  assert.equal(second.status, 1);
  assert.ok(!existsSync(path.join(outDir, 'etat.json')), 'ancien compte rendu effacé');
});

test('exécutable introuvable ou délai invalide : échec immédiat', () => {
  const env = { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' };
  const missing = spawnSync(process.execPath, [SCRIPT, path.join(workDir, 'absent.exe'), `--out=${path.join(workDir, 'x')}`], { encoding: 'utf8', env });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /✖ exécutable introuvable : .*absent\.exe/);

  for (const option of ['--timeout=abc', '--timeout=0', '--close-timeout=-1', '--observe=-1', '--observe=x']) {
    const invalid = spawnSync(process.execPath, [SCRIPT, process.execPath, option, `--out=${path.join(workDir, 'y')}`], { encoding: 'utf8', env });
    assert.equal(invalid.status, 1, option);
    assert.match(invalid.stdout, /✖ (délai|durée d'observation) invalide/, option);
  }
});

test('sur GitHub Actions : annotation et résumé', posixOnly, () => {
  const summary = path.join(workDir, 'resume.md');
  writeFileSync(summary, '');
  const passed = run('ok', { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  const notices = passed.output.split('\n').filter((line) => line.startsWith('::'));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^::notice title=Lancement normal — node::✔ interface démarrée \(état signalé [\d.]+ s après le lancement\)%0A✔ fenêtre visible, en plein écran/);
  assert.match(notices[0], /%0A✔ fichiers temporaires supprimés à la fermeture/);
  assert.match(notices[0], /%0A· espace temporaire occupé pendant le fonctionnement : 3 Mo/);
  const summaryText = readFileSync(summary, 'utf8');
  assert.match(summaryText, /^### ✅ Lancement normal de l'exécutable \(comme un double-clic\)\n\n- ✔ interface démarrée/);
  assert.match(summaryText, /\n- · espace temporaire occupé/);

  const failed = run('hidden', { env: { GITHUB_ACTIONS: 'true' } });
  const errors = failed.output.split('\n').filter((line) => line.startsWith('::'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^::error title=Lancement normal — node::.*✖ la fenêtre n'est pas visible/);
});

// --- Déroulement complet avec capture de l'écran -----------------------------------------
// La capture réelle n'existe que sous Windows : elle est remplacée ici par une
// image fournie par le test, pour exercer la comparaison dans le déroulement.

const SMALL_DISPLAY = { bounds: { x: 0, y: 0, width: 640, height: 360 }, display: { x: 0, y: 0, width: 640, height: 360, scaleFactor: 1 } };
const renderPng = png(640, 360, desktop(640, 360));
const blackPng = png(640, 360, () => [0, 0, 0]);

/**
 * Exécute la vérification dans le processus du test, avec une capture d'écran simulée.
 * @param {object} options
 * @param {Buffer|null} options.screen image « affichée par l'écran » (null : capture impossible)
 * @param {'app'|number|null} [options.foreground] fenêtre au premier plan : celle de l'application, un autre processus, inconnue
 * @param {object} [options.status] modifications de l'état signalé par la fausse application
 * @param {boolean} [options.render] la fausse application enregistre-t-elle l'image qu'elle dessine ?
 */
async function runWithScreen(t, { screen, foreground = 'app', status = {}, render = true, mode = 'ok', appArgs = [] }) {
  const outDir = path.join(workDir, `ecran-${Math.random().toString(36).slice(2, 8)}`);
  const tempDir = path.join(outDir, 'temp');
  mkdirSync(tempDir, { recursive: true });
  const renderFile = path.join(outDir, 'rendu-simule.png');
  if (render) writeFileSync(renderFile, renderPng);

  const saved = { ...process.env };
  Object.assign(process.env, {
    TMPDIR: tempDir,
    GITHUB_ACTIONS: '',
    GITHUB_STEP_SUMMARY: '',
    FAKE_STATUS: JSON.stringify({ ...SMALL_DISPLAY, capture: render ? renderFile : null, ...status }),
  });
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));

  const captured = [];
  const capture = (pngFile) => {
    captured.push(pngFile);
    if (!screen) return { unavailable: 'capture simulée impossible' };
    const { pid } = JSON.parse(readFileSync(path.join(path.dirname(pngFile), 'etat.json'), 'utf8'));
    return {
      bytes: screen,
      foregroundPid: foreground === 'app' ? pid : foreground,
      foregroundTitle: foreground === 'app' ? 'Evolve' : 'Invite de commandes',
    };
  };

  try {
    const code = await main(
      [process.execPath, `--out=${outDir}`, '--timeout=20', '--close-timeout=20', '--observe=0.1', '--', FAKE_APP, mode, ...appArgs],
      { capture },
    );
    return { code, output: output.join('\n'), outDir, captured };
  } finally {
    t.mock.restoreAll();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('écran conforme, fenêtre au premier plan : lancement conforme', posixOnly, async (t) => {
  const { code, output, outDir, captured } = await runWithScreen(t, { screen: renderPng });
  assert.equal(code, 0, output);
  assert.match(output, /✔ fenêtre visible, en plein écran : 640 × 360 sur un écran de 640 × 360/);
  assert.match(output, /✔ l'écran affiche l'interface : 100 % de l'écran \(640 × 360\) correspond à l'image dessinée par l'application/);
  assert.match(output, /· fenêtre au premier plan pendant la capture : celle de l'application/);
  assert.ok(!output.includes('  ! '), 'aucun avertissement');
  assert.deepEqual(captured, [path.join(outDir, 'ecran.png')]);
});

test('écran noir alors que la fenêtre est au premier plan : échec', posixOnly, async (t) => {
  const { code, output } = await runWithScreen(t, { screen: blackPng });
  assert.equal(code, 1, output);
  assert.match(output, /✖ l'écran n'affiche pas l'interface alors que sa fenêtre est au premier plan : \d+ % de l'écran \(640 × 360\) seulement/);
  assert.match(output, /✔ fermeture normale/, "l'application est tout de même refermée");
  assert.match(output, /ne doit pas être distribué/);
});

test('autre fenêtre au premier plan : écran non concluant, signalé sans bloquer', posixOnly, async (t) => {
  const other = await runWithScreen(t, { screen: blackPng, foreground: 4242 });
  assert.equal(other.code, 0, other.output);
  assert.match(other.output, /· fenêtre au premier plan pendant la capture : « Invite de commandes » \(processus 4242\), et non celle de l'application/);
  assert.match(other.output, /! l'écran ne montre pas l'interface .*la fenêtre de l'application n'est pas au premier plan sur cette machine/);

  const none = await runWithScreen(t, { screen: blackPng, foreground: 0 });
  assert.equal(none.code, 0, none.output);
  assert.match(none.output, /· aucune fenêtre au premier plan pendant la capture/);

  const unknown = await runWithScreen(t, { screen: blackPng, foreground: null });
  assert.equal(unknown.code, 0, unknown.output);
  assert.ok(!unknown.output.includes('fenêtre au premier plan pendant la capture'));
  assert.match(unknown.output, /! l'écran ne montre pas l'interface .*la fenêtre au premier plan n'a pas pu être identifiée/);
});

test('affichage de Windows agrandi : dimensions réelles de l’écran attendues', posixOnly, async (t) => {
  // Écran de 960 × 540 points vu comme 640 × 360 par l'application (agrandissement de 150 %).
  const scaled = { display: { x: 0, y: 0, width: 640, height: 360, scaleFactor: 1.5 } };
  const full = await runWithScreen(t, { screen: png(960, 540, desktop(960, 540)), status: scaled });
  assert.equal(full.code, 0, full.output);
  assert.match(full.output, /✔ l'écran affiche l'interface : 100 % de l'écran \(960 × 540\)/);

  // Capture tronquée (640 × 360 au lieu de 960 × 540) : jamais un échec.
  const cropped = await runWithScreen(t, { screen: blackPng, status: scaled });
  assert.equal(cropped.code, 0, cropped.output);
  assert.match(cropped.output, /! capture de l'écran aux dimensions inattendues \(640 × 360 au lieu de 960 × 540\)/);
});

test('comparaison impossible : écran secondaire, image absente ou illisible, capture impossible', posixOnly, async (t) => {
  const secondary = await runWithScreen(t, {
    screen: blackPng,
    status: { bounds: { x: 1920, y: 0, width: 640, height: 360 }, display: { x: 1920, y: 0, width: 640, height: 360, scaleFactor: 1 } },
  });
  assert.equal(secondary.code, 0, secondary.output);
  assert.match(secondary.output, /! la fenêtre est affichée sur un écran secondaire : la capture de l'écran principal n'a pas été comparée/);

  const noRender = await runWithScreen(t, { screen: blackPng, render: false });
  assert.equal(noRender.code, 0, noRender.output);
  assert.match(noRender.output, /! l'application n'a pas enregistré l'image qu'elle dessine/);

  const missing = await runWithScreen(t, { screen: blackPng, status: { capture: path.join(workDir, 'image-absente.png') } });
  assert.equal(missing.code, 0, missing.output);
  assert.match(missing.output, /! comparaison de l'écran impossible : /);

  const unreadable = await runWithScreen(t, { screen: Buffer.from('pas une image') });
  assert.equal(unreadable.code, 0, unreadable.output);
  assert.match(unreadable.output, /! comparaison de l'écran impossible : ce fichier n'est pas une image PNG/);

  const unavailable = await runWithScreen(t, { screen: null });
  assert.equal(unavailable.code, 0, unavailable.output);
  assert.match(unavailable.output, /! écran non capturé : capture simulée impossible/);
});

test('mode fenêtré : écran capturé, sans comparaison', posixOnly, async (t) => {
  const { code, output, captured } = await runWithScreen(t, {
    screen: blackPng,
    mode: 'windowed',
    appArgs: ['--windowed'],
    status: { bounds: { x: 20, y: 20, width: 600, height: 320 } },
  });
  assert.equal(code, 0, output);
  assert.equal(captured.length, 1);
  assert.match(output, /✔ fenêtre visible, en mode fenêtré : 600 × 320 sur un écran de 640 × 360/);
  assert.match(output, /· mode fenêtré : l'écran a été capturé, sans comparaison/);
  assert.ok(!output.includes("l'écran affiche"));
});

test('application fermée toute seule : aucune capture de l’écran', posixOnly, async (t) => {
  const outDir = path.join(workDir, 'fermee-seule');
  const tempDir = path.join(outDir, 'temp');
  mkdirSync(tempDir, { recursive: true });
  const saved = { ...process.env };
  Object.assign(process.env, { TMPDIR: tempDir, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', FAKE_STATUS: '' });
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  let captures = 0;
  try {
    const code = await main([process.execPath, `--out=${outDir}`, '--timeout=20', '--observe=1', '--', FAKE_APP, 'self-exit'], {
      capture: () => {
        captures += 1;
        return { unavailable: 'inattendu' };
      },
    });
    assert.equal(code, 1);
    assert.equal(captures, 0);
    assert.match(output.join('\n'), /✖ l'application s'est fermée toute seule \(code 0\)/);
  } finally {
    t.mock.restoreAll();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
