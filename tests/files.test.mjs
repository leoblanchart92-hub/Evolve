/**
 * Service « files » (src/services/files.js) : consultation des dossiers de
 * l'ordinateur, en lecture seule.
 *
 * La plupart des tests s'appuient sur un faux disque Windows en mémoire
 * (tests/fixtures/fake-fs.cjs) : lettres de lecteur, jonctions, dossiers
 * protégés, lecteurs réseau, lecteur qui ne répond pas. Les derniers
 * utilisent le vrai disque, dans un dossier temporaire.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { readText, stripComments } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createFilesService, PLACE_IDS, READ_ONLY_CALLS, DEFAULT_LIMITS } = require('../src/services/files.js');
const { createServices } = require('../src/services/index.js');
const { ServiceError } = require('../src/services/hub.js');
const { createFakeFs, file, dir, link, other } = require('./fixtures/fake-fs.cjs');

const MARCH = Date.UTC(2026, 2, 14, 15, 9);
/** Date par défaut des éléments du faux disque. */
const DATE_OF_FAKE = Date.UTC(2026, 0, 15, 9, 30);

/** Faux disque d'un PC sous Windows. */
function windowsDisk(extra = {}) {
  return createFakeFs({
    platform: 'win32',
    drives: {
      'C:\\': {
        totalBytes: 512_000_000_000,
        freeBytes: 128_000_000_000,
        tree: {
          '$Recycle.Bin': dir({}, { deny: 'EPERM' }),
          'Documents and Settings': link('C:\\Users'),
          'Program Files': { 'Mozilla Firefox': { 'firefox.exe': file(680_000) } },
          ProgramData: {},
          'System Volume Information': dir({}, { deny: 'EPERM' }),
          Users: {
            'All Users': link('C:\\ProgramData'),
            Default: {},
            Léo: {
              AppData: { Roaming: {} },
              'Application Data': link('C:\\Users\\Léo\\AppData\\Roaming'),
              Desktop: { 'Notes.txt': file(7, MARCH) },
              Documents: {
                'Budget 2026.xlsx': file(48_300, MARCH),
                'Mes images': link('C:\\Users\\Léo\\Pictures'),
                Projets: { 'Été 2026': { 'plan.pdf': file(3) } },
                'Vers Windows': link('C:\\Windows'),
                'Vers le NAS': link('\\\\nas\\partage\\Documents'),
                'Vers nulle part': link('C:\\Absent'),
                'desktop.ini': file(402),
              },
              Downloads: {},
              Music: {},
              Pictures: { 'fond.png': file(3_100_000) },
              'NTUSER.DAT': file(3_670_016),
              'ntuser.ini': file(20),
            },
            Public: {},
          },
          Windows: { 'win.ini': file(92) },
          'pagefile.sys': file(2_400_000_000),
        },
      },
      'D:\\': { totalBytes: 1_000_000_000_000, freeBytes: 409_600_000_000, tree: { Jeux: {}, Thumbs: {}, 'Thumbs.db': file(9) } },
      // Partage réseau joignable, et lettre qui y mène.
      '\\\\nas\\partage\\': { tree: { Documents: { 'secret.txt': file(1) }, Films: {} } },
      'Z:\\': { target: '\\\\nas\\partage\\', tree: { Documents: { 'secret.txt': file(1) }, Films: {} } },
      ...extra.drives,
    },
    errors: extra.errors,
    hang: extra.hang,
  });
}

const PROFILE = 'C:\\Users\\Léo';
const WINDOWS_PLACES = Object.freeze({
  desktop: `${PROFILE}\\Desktop`,
  documents: `${PROFILE}\\Documents`,
  downloads: `${PROFILE}\\Downloads`,
  pictures: `${PROFILE}\\Pictures`,
  music: `${PROFILE}\\Music`,
  videos: `${PROFILE}\\Videos`, // absent du disque
});

/** Service relié à un faux disque Windows. */
function windowsService(options = {}, extra = {}) {
  const disk = windowsDisk(extra);
  const service = createFilesService({
    platform: 'win32',
    fs: disk.fs,
    env: { SystemDrive: 'C:' },
    places: WINDOWS_PLACES,
    drives: 'auto',
    limits: { probeMs: 200 },
    ...options,
  });
  return { disk, service };
}

/** Attend un refus du service et renvoie son code. */
async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, `erreur inattendue : ${error?.stack ?? error}`);
    return error.code;
  }
  return 'accepté';
}

const namesOf = (listing) => listing.entries.map((entry) => entry.name);
const entryOf = (listing, name) => listing.entries.find((entry) => entry.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------
// Lecture seule
// ---------------------------------------------------------------------------------

test('le service ne propose que deux opérations, toutes deux de consultation', () => {
  const { service } = windowsService();
  assert.deepEqual(Object.keys(service).sort(), ['list', 'places', 'status']);
  assert.deepEqual(service.status(), { access: 'read-only', places: null, drives: null });
  assert.deepEqual(READ_ONLY_CALLS, ['opendir', 'lstat', 'realpath', 'statfs']);
  assert.ok(Object.isFrozen(READ_ONLY_CALLS) && Object.isFrozen(PLACE_IDS) && Object.isFrozen(DEFAULT_LIMITS));
  assert.deepEqual(PLACE_IDS, ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']);
});

test('le code du service n’utilise que les quatre fonctions de lecture du système de fichiers', () => {
  const code = stripComments(readText('src', 'services', 'files.js'));
  // Le module de fichiers n'est atteint que par « disk », construit à partir de ces quatre fonctions.
  const viaDisk = new Set([...code.matchAll(/\bdisk\.(\w+)/g)].map((match) => match[1]));
  assert.deepEqual([...viaDisk].sort(), [...READ_ONLY_CALLS].sort());
  const viaModule = new Set([...code.matchAll(/\bfsModule\.(\w+)/g)].map((match) => match[1]));
  assert.deepEqual([...viaModule].sort(), [...READ_ONLY_CALLS].sort());
  // Le module de Node lui-même n'est que la valeur par défaut de l'option « fs ».
  assert.deepEqual([...code.matchAll(/\bnodeFs\b[^\n]*/g)].map((match) => match[0].slice(0, 6)), ['nodeFs', 'nodeFs']);
  assert.match(code, /const nodeFs = require\('node:fs'\);/);
  assert.match(code, /fs = nodeFs,/);
  assert.doesNotMatch(code, /\bfs\.\w+\(|\bfs\[/, 'aucun appel direct au module de fichiers');
  assert.doesNotMatch(code, /node:fs\/promises/);
  // Aucun nom d'opération d'écriture ou de lecture de contenu, sous aucune forme.
  assert.doesNotMatch(code, /\b(?:writeFile|appendFile|createWriteStream|createReadStream|readFile|unlink|rmdir|rm|rename|mkdir|mkdtemp|copyFile|cp|truncate|ftruncate|chmod|chown|utimes|symlink|link|open|write|read|readdir|readv|writev)(?:Sync)?\s*\(/);
});

test('une visite complète du disque ne touche que les fonctions de lecture et referme chaque dossier', async () => {
  const { disk, service } = windowsService();
  await service.places();
  for (const folder of ['C:\\', 'C:\\Users', PROFILE, WINDOWS_PLACES.documents, 'C:\\Documents and Settings', 'D:\\']) await service.list(folder);
  for (const folder of ['C:\\System Volume Information', 'C:\\Absent', 'C:\\Windows\\win.ini', 'Z:\\Films']) await refusal(service.list(folder));

  assert.deepEqual([...disk.touched].sort(), [...READ_ONLY_CALLS].sort());
  assert.deepEqual([...new Set(disk.calls.map(([name]) => name))].sort(), [...READ_ONLY_CALLS].sort());
  assert.equal(disk.state.openHandles, 0, 'aucun dossier laissé ouvert');
  assert.ok(disk.state.opened >= 6);
});

// ---------------------------------------------------------------------------------
// Forme des chemins
// ---------------------------------------------------------------------------------

test('chemins refusés sur leur seule forme, avant tout accès au disque (Windows)', async () => {
  const { disk, service } = windowsService();
  const refused = [
    // Pas une chaîne, vide, démesuré, caractères de contrôle.
    undefined, null, 42, true, {}, ['C:\\'], '', ' ', 'C:\\Users\u0000', 'C:\\Users\n', `C:\\${'a'.repeat(DEFAULT_LIMITS.pathLength)}`,
    // Chemins relatifs.
    'Users', '.', '..', '.\\Users', '..\\Users', 'Users\\Léo', '\\Users', '/Users', 'C:', 'C:Users', 'c:users\\léo',
    // Remontées : aucun « .. » ni « . », même au milieu ou à la fin, même déguisé.
    'C:\\Users\\..', 'C:\\Users\\..\\Windows', 'C:\\Users\\Léo\\..\\..', 'C:/Users/../Windows', 'C:\\Users\\.', 'C:\\.\\Users', 'C:\\Users\\...', 'C:\\Users\\.. ', 'C:\\Users\\. .',
    // Partages réseau et espaces de noms.
    '\\\\nas\\partage', '\\\\nas\\partage\\Documents', '//nas/partage', '\\\\?\\C:\\Users', '\\\\.\\C:\\Users', '\\\\?\\UNC\\nas\\partage', '\\\\.\\PhysicalDrive0', '\\\\localhost\\C$',
    // Flux secondaires et caractères interdits.
    'C:\\Users\\Léo:flux', 'C:\\Users\\Léo\\Notes.txt::$DATA', 'C:\\Users\\D:\\Jeux', 'C:\\Users\\*', 'C:\\Users\\L?o', 'C:\\Users\\<Léo>', 'C:\\Users\\"Léo"', 'C:\\Users\\Léo|x',
    // Noms de périphériques.
    'C:\\NUL', 'C:\\Users\\nul', 'C:\\Users\\CON', 'C:\\Users\\con.txt', 'C:\\Users\\PRN', 'C:\\Users\\AUX', 'C:\\Users\\COM1', 'C:\\Users\\com9.log', 'C:\\Users\\LPT1', 'C:\\Users\\LPT\u00b9', 'C:\\Users\\COM\u00b2.txt', 'C:\\Users\\CONIN$', 'C:\\Users\\conout$', 'C:\\Users\\NUL .txt',
  ];
  for (const value of refused) {
    assert.equal(await refusal(service.list(value)), 'invalid-path', `chemin : ${JSON.stringify(value)}`);
  }
  assert.deepEqual(disk.calls, [], 'le disque n’a reçu aucune demande');
});

test('chemins refusés sur leur seule forme (autres systèmes)', async () => {
  const disk = createFakeFs({ platform: 'linux', drives: { '/': { tree: { home: { leo: { Documents: {} } } } } } });
  const service = createFilesService({ platform: 'linux', fs: disk.fs, drives: 'auto', places: { documents: '/home/leo/Documents' } });
  for (const value of [undefined, 7, '', 'home', './home', '../home', '/home/..', '/home/../etc', '/home/./leo', '/home/leo/..', 'C:\\Users', '/home\u0000', '/home/...']) {
    assert.equal(await refusal(service.list(value)), 'invalid-path', `chemin : ${JSON.stringify(value)}`);
  }
  assert.deepEqual(disk.calls, []);
  // Barres obliques répétées ou finales : simple écriture différente du même dossier.
  assert.equal((await service.list('//home///leo/')).path, '/home/leo');
  assert.equal((await service.list('/')).path, '/');
});

test('écritures équivalentes d’un même dossier : casse, barres obliques, barre finale', async () => {
  const { service } = windowsService();
  for (const written of ['C:\\Users\\Léo\\Documents', 'c:\\users\\léo\\documents', 'C:/Users/Léo/Documents', 'C:\\Users\\\\Léo\\Documents\\', 'C:\\USERS\\LÉO\\DOCUMENTS']) {
    const listing = await service.list(written);
    assert.equal(listing.path, 'C:\\Users\\Léo\\Documents', written);
    assert.deepEqual(listing.root, { id: 'documents', kind: 'place', path: 'C:\\Users\\Léo\\Documents' });
  }
  assert.equal((await service.list('c:/')).path, 'C:\\');
});

// ---------------------------------------------------------------------------------
// Emplacements autorisés
// ---------------------------------------------------------------------------------

test('emplacements : les six dossiers personnels, dans l’ordre, et les lecteurs locaux', async () => {
  const { service } = windowsService();
  const found = await service.places();
  assert.deepEqual(found.places, [
    { id: 'desktop', path: 'C:\\Users\\Léo\\Desktop', available: true },
    { id: 'documents', path: 'C:\\Users\\Léo\\Documents', available: true },
    { id: 'downloads', path: 'C:\\Users\\Léo\\Downloads', available: true },
    { id: 'pictures', path: 'C:\\Users\\Léo\\Pictures', available: true },
    { id: 'music', path: 'C:\\Users\\Léo\\Music', available: true },
    { id: 'videos', path: null, available: false },
  ]);
  assert.deepEqual(found.drives, [
    { id: 'C:', letter: 'C', path: 'C:\\', system: true, totalBytes: 512_000_000_000, freeBytes: 128_000_000_000 },
    { id: 'D:', letter: 'D', path: 'D:\\', system: false, totalBytes: 1_000_000_000_000, freeBytes: 409_600_000_000 },
  ]);
  assert.deepEqual(service.status(), { access: 'read-only', places: 5, drives: 2 });
});

test('recherche des lecteurs : les 26 lettres, disques durs d’abord, et rien d’autre que leur racine', async () => {
  const { disk, service } = windowsService();
  await service.places();
  const probed = disk.pathsOf('realpath').filter((target) => /^[A-Z]:\\$/.test(target));
  assert.deepEqual([...probed].sort(), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`));
  assert.equal(probed.indexOf('C:\\'), 0, 'C: en premier');
  assert.deepEqual(probed.slice(-2).sort(), ['A:\\', 'B:\\'], 'lecteurs de disquettes en dernier');
  // La capacité n'est demandée qu'aux lecteurs retenus.
  assert.deepEqual(disk.pathsOf('statfs').sort(), ['C:\\', 'D:\\']);
  assert.deepEqual(disk.pathsOf('opendir'), [], 'aucun dossier n’est lu pour dresser la liste des emplacements');
});

test('un lecteur réseau ou virtuel n’est pas un emplacement : ni listé, ni consultable', async () => {
  const { disk, service } = windowsService();
  const found = await service.places();
  assert.ok(!found.drives.some((drive) => drive.letter === 'Z'));
  for (const target of ['Z:\\', 'Z:\\Films', 'z:/documents', 'Q:\\', 'Q:\\Dossier']) {
    assert.equal(await refusal(service.list(target)), 'outside-allowed', target);
  }
  // Refus sans toucher au disque : la seule demande reçue pour Z: est celle de la recherche des lecteurs.
  const onNetwork = disk.calls.filter(([, target]) => /^(?:z:|q:|\\\\)/i.test(target));
  assert.deepEqual(onNetwork, [['realpath', 'Q:\\'], ['realpath', 'Z:\\']]);
});

test('dossier personnel indisponible : absent, fichier, sur le réseau, hors des lecteurs locaux ou mal désigné', async () => {
  const cases = {
    desktop: `${PROFILE}\\Bureau introuvable`,
    documents: `${PROFILE}\\NTUSER.DAT`, // un fichier
    downloads: '\\\\nas\\partage\\Documents', // partage réseau
    pictures: 'Z:\\Films', // lettre associée à un partage réseau
    music: 'Images', // chemin relatif
    videos: `${PROFILE}\\Documents\\Vers le NAS`, // lien qui mène sur le réseau
  };
  const { disk, service } = windowsService({ places: cases });
  const found = await service.places();
  assert.deepEqual(found.places, PLACE_IDS.map((id) => ({ id, path: null, available: false })));
  assert.deepEqual(service.status(), { access: 'read-only', places: 0, drives: 2 });
  // Ni le partage ni la lettre réseau n'ont été consultés pour le savoir.
  assert.ok(!disk.calls.some(([name, target]) => name !== 'realpath' && /^(?:z:|\\\\)/i.test(target)));
  assert.ok(!disk.pathsOf('realpath').some((target) => /^\\\\/.test(target) || /^Z:\\./i.test(target)));

  for (const value of [null, undefined, 42, '', {}]) {
    const other = windowsService({ places: { ...WINDOWS_PLACES, documents: value } });
    const places = (await other.service.places()).places;
    assert.deepEqual(places.find((place) => place.id === 'documents'), { id: 'documents', path: null, available: false }, String(value));
    assert.equal(places.filter((place) => place.available).length, 4);
  }
});

test('un dossier personnel déplacé est désigné par son emplacement réel (lien, casse)', async () => {
  const { service } = windowsService({ places: { documents: 'c:/users/léo/documents/', pictures: `${PROFILE}\\Documents\\Mes images`, desktop: 'D:\\Jeux' } });
  const { places } = await service.places();
  assert.equal(places.find((place) => place.id === 'documents').path, 'C:\\Users\\Léo\\Documents');
  assert.equal(places.find((place) => place.id === 'pictures').path, 'C:\\Users\\Léo\\Pictures');
  assert.equal(places.find((place) => place.id === 'desktop').path, 'D:\\Jeux');
});

test('les dossiers personnels ne sont demandés à l’hôte qu’au premier besoin, et une seule fois s’il les situe tous', async () => {
  let asked = 0;
  const { disk, service } = windowsService({
    places: () => {
      asked += 1;
      return WINDOWS_PLACES;
    },
  });
  assert.equal(asked, 0, 'rien n’est demandé à la création du service');
  assert.deepEqual(disk.calls, [], 'ni au disque');
  await refusal(service.list('..'));
  assert.equal(asked, 0, 'un chemin refusé sur sa forme ne déclenche aucune recherche');

  await service.list(WINDOWS_PLACES.documents);
  assert.equal(asked, 1);
  await service.places();
  await service.places();
  await service.list('C:\\');
  assert.equal(asked, 1, 'une seule demande par session');

  // Hôte en panne : aucun dossier personnel, mais les lecteurs restent consultables.
  let failures = 0;
  const broken = windowsService({
    places: () => {
      failures += 1;
      throw new Error('Failed to get path');
    },
  });
  const found = await broken.service.places();
  assert.equal(found.places.filter((place) => place.available).length, 0);
  assert.equal(found.drives.length, 2);
  assert.equal((await broken.service.list('D:\\')).path, 'D:\\');
  // Il est sollicité de nouveau à la recherche suivante — jamais par la simple consultation d'un dossier.
  assert.equal(failures, 1);
  await broken.service.places();
  assert.equal(failures, 2);
});

test('un dossier personnel que l’hôte n’a pas su situer lui est redemandé à chaque nouvelle recherche, et lui seul', async () => {
  // L'hôte ne situe pas « Documents » (absent du PC) ni « Musique », puis finit par situer « Documents ».
  const answers = [
    { ...WINDOWS_PLACES, documents: null, music: '' },
    { documents: null, music: undefined, desktop: 'D:\\Jeux' }, // « desktop », déjà situé, n'est pas remplacé
    { documents: WINDOWS_PLACES.documents, music: 42 },
    { music: null },
  ];
  const received = [];
  const { service } = windowsService({
    places: (known) => {
      received.push(known);
      return answers[received.length - 1];
    },
  });
  const state = async () => Object.fromEntries((await service.places()).places.map((place) => [place.id, place.path]));
  const located = { desktop: WINDOWS_PLACES.desktop, downloads: WINDOWS_PLACES.downloads, pictures: WINDOWS_PLACES.pictures, videos: WINDOWS_PLACES.videos };

  // Première recherche : rien n'est encore connu.
  const first = await state();
  assert.deepEqual(received[0], { desktop: null, documents: null, downloads: null, pictures: null, music: null, videos: null });
  assert.deepEqual([first.documents, first.music, first.desktop], [null, null, WINDOWS_PLACES.desktop]);

  // Consulter des dossiers ne redemande rien.
  await service.list('C:\\Users');
  await service.list(WINDOWS_PLACES.desktop);
  assert.equal(received.length, 1);

  // Deuxième recherche : l'hôte reçoit les emplacements déjà obtenus — « videos » compris, bien qu'absent du disque.
  const second = await state();
  assert.deepEqual(received[1], { ...located, documents: null, music: null });
  assert.deepEqual([second.documents, second.desktop], [null, WINDOWS_PLACES.desktop]);

  // Troisième recherche : « Documents » est revenu ; il devient consultable.
  const third = await state();
  assert.equal(third.documents, WINDOWS_PLACES.documents);
  assert.equal(third.music, null, 'une réponse qui n’est pas un chemin est ignorée');
  assert.equal((await service.list(WINDOWS_PLACES.documents)).root.id, 'documents');

  // Quatrième recherche : seul « Musique » reste à situer.
  await state();
  assert.deepEqual(received[3], { ...located, documents: WINDOWS_PLACES.documents, music: null });
  // Ce que l'hôte reçoit est une copie : la modifier ne change rien pour le service.
  received[3].desktop = 'Z:\\Films';
  assert.equal((await state()).desktop, WINDOWS_PLACES.desktop);
  assert.equal(received.length, 5);
});

test('sans lecteur autorisé, seuls les dossiers personnels sont consultables', async () => {
  const { disk, service } = windowsService({ drives: undefined });
  const found = await service.places();
  assert.deepEqual(found.drives, []);
  assert.equal(found.places.filter((place) => place.available).length, 5);
  assert.deepEqual(disk.pathsOf('statfs'), []);

  const listing = await service.list(`${WINDOWS_PLACES.documents}\\Projets\\Été 2026`);
  assert.deepEqual(listing.root, { id: 'documents', kind: 'place', path: WINDOWS_PLACES.documents });
  assert.deepEqual(listing.trail, [
    { name: 'Projets', path: `${WINDOWS_PLACES.documents}\\Projets` },
    { name: 'Été 2026', path: `${WINDOWS_PLACES.documents}\\Projets\\Été 2026` },
  ]);

  const before = disk.calls.length;
  for (const target of [PROFILE, 'C:\\Users', 'C:\\', 'C:\\Windows', 'D:\\', `${PROFILE}\\AppData`, `${PROFILE}\\Documents2`, `${PROFILE}\\Doc`]) {
    assert.equal(await refusal(service.list(target)), 'outside-allowed', target);
  }
  assert.equal(disk.calls.length, before, 'refus sans aucun accès au disque');
});

test('un lien qui mène hors des emplacements autorisés n’est pas suivi', async () => {
  // Sans lecteur autorisé : « Vers Windows » sort du dossier Documents.
  const restricted = windowsService({ drives: undefined });
  assert.equal(await refusal(restricted.service.list(`${WINDOWS_PLACES.documents}\\Vers Windows`)), 'leads-outside');
  assert.deepEqual(restricted.disk.pathsOf('opendir'), [], 'la destination n’est jamais lue');
  assert.equal(restricted.disk.pathsOf('lstat').some((target) => /^C:\\Windows/i.test(target)), false);
  // Un lien entre deux dossiers personnels reste permis : la destination est autorisée.
  const pictures = await restricted.service.list(`${WINDOWS_PLACES.documents}\\Mes images`);
  assert.equal(pictures.path, WINDOWS_PLACES.pictures);
  assert.equal(pictures.root.id, 'pictures');

  // Lecteurs autorisés : le même lien mène à un dossier du disque C:, donc permis…
  const { disk, service } = windowsService();
  assert.equal((await service.list(`${WINDOWS_PLACES.documents}\\Vers Windows`)).path, 'C:\\Windows');
  // … mais un lien vers un partage réseau ne l'est jamais, et rien n'y est lu.
  assert.equal(await refusal(service.list(`${WINDOWS_PLACES.documents}\\Vers le NAS`)), 'leads-outside');
  assert.equal(await refusal(service.list(`${WINDOWS_PLACES.documents}\\Vers nulle part`)), 'not-found');
  assert.ok(!disk.calls.some(([name, target]) => name !== 'realpath' && /^\\\\/.test(target)));
});

test('l’emplacement retenu est le plus précis ; le fil d’Ariane part de lui', async () => {
  const { service } = windowsService();
  const inPlace = await service.list(`${WINDOWS_PLACES.documents}\\Projets`);
  assert.deepEqual(inPlace.root, { id: 'documents', kind: 'place', path: WINDOWS_PLACES.documents });
  assert.deepEqual(inPlace.trail, [{ name: 'Projets', path: `${WINDOWS_PLACES.documents}\\Projets` }]);

  const onDrive = await service.list(`${PROFILE}\\AppData`);
  assert.deepEqual(onDrive.root, { id: 'C:', kind: 'drive', path: 'C:\\' });
  assert.deepEqual(onDrive.trail.map((step) => step.name), ['Users', 'Léo', 'AppData']);
  assert.deepEqual(onDrive.trail.map((step) => step.path), ['C:\\Users', 'C:\\Users\\Léo', 'C:\\Users\\Léo\\AppData']);

  const root = await service.list('D:\\');
  assert.deepEqual(root.root, { id: 'D:', kind: 'drive', path: 'D:\\' });
  assert.deepEqual(root.trail, []);

  // Jonction du système : le dossier présenté est sa destination réelle.
  const junction = await service.list('C:\\Documents and Settings\\Léo\\Desktop');
  assert.equal(junction.path, WINDOWS_PLACES.desktop);
  assert.equal(junction.root.id, 'desktop');
});

// ---------------------------------------------------------------------------------
// Contenu d'un dossier
// ---------------------------------------------------------------------------------

test('contenu d’un dossier : nom, chemin, nature, taille et date de chaque élément', async () => {
  const { service } = windowsService();
  const listing = await service.list(WINDOWS_PLACES.documents);
  assert.deepEqual(Object.keys(listing), ['path', 'root', 'trail', 'entries', 'truncated', 'limit']);
  assert.equal(listing.truncated, false);
  assert.equal(listing.limit, DEFAULT_LIMITS.entries);
  assert.deepEqual(namesOf(listing), ['Budget 2026.xlsx', 'Mes images', 'Projets', 'Vers Windows', 'Vers le NAS', 'Vers nulle part', 'desktop.ini']);

  assert.deepEqual(entryOf(listing, 'Budget 2026.xlsx'), {
    name: 'Budget 2026.xlsx',
    path: `${WINDOWS_PLACES.documents}\\Budget 2026.xlsx`,
    kind: 'file',
    size: 48_300,
    modified: MARCH,
    hidden: false,
  });
  const folder = entryOf(listing, 'Projets');
  assert.deepEqual([folder.kind, folder.size, folder.hidden], ['folder', null, false]);
  assert.equal(typeof folder.modified, 'number');
  // Un lien est signalé comme tel, sans taille : sa destination n'est pas consultée.
  for (const name of ['Mes images', 'Vers Windows', 'Vers le NAS', 'Vers nulle part']) {
    const item = entryOf(listing, name);
    assert.deepEqual([item.kind, item.size], ['link', null], name);
  }
  // Données simples, transmissibles telles quelles à l'interface.
  assert.deepEqual(JSON.parse(JSON.stringify(listing)), listing);
});

test('les liens d’un dossier ne sont jamais suivis pendant sa lecture', async () => {
  const { disk, service } = windowsService();
  await service.places();
  const before = disk.calls.length;
  await service.list(WINDOWS_PLACES.documents);
  const touched = disk.calls.slice(before);
  // Une résolution du dossier demandé, son ouverture, puis un constat par élément — rien sur les destinations.
  assert.deepEqual(touched.filter(([name]) => name === 'realpath'), [['realpath', WINDOWS_PLACES.documents]]);
  assert.deepEqual(touched.filter(([name]) => name === 'opendir'), [['opendir', WINDOWS_PLACES.documents]]);
  for (const [name, target] of touched) {
    assert.ok(target.startsWith(WINDOWS_PLACES.documents), `${name} ${target}`);
  }
  // Un constat par élément du dossier, lien compris — et aucun sur ce que les liens désignent.
  assert.equal(touched.filter(([name]) => name === 'lstat').length, 1 + 7);
  for (const destination of ['C:\\Users\\Léo\\Pictures', 'C:\\Windows', '\\\\nas\\partage\\Documents', 'C:\\Absent']) {
    assert.ok(!touched.some(([, target]) => target === destination), destination);
  }
});

test('élément ni fichier ni dossier, et élément verrouillé : affichés sans taille ni date', async () => {
  const { service } = windowsService({}, {
    drives: { 'E:\\': { tree: { 'canal': other(), 'verrou.sys': file(5), Dossier: {}, 'lien': link('E:\\Dossier') } } },
    errors: { lstat: { 'E:\\verrou.sys': 'EBUSY', 'E:\\Dossier': 'EPERM', 'E:\\lien': 'EACCES' } },
  });
  const listing = await service.list('E:\\');
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.kind, entry.size, entry.modified]),
    [
      ['canal', 'other', null, DATE_OF_FAKE],
      ['verrou.sys', 'file', null, null],
      ['Dossier', 'folder', null, null],
      ['lien', 'link', null, null],
    ],
  );
});

test('éléments masqués par l’Explorateur de Windows : signalés d’après leur nom et leur place', async () => {
  const { service } = windowsService();
  const hiddenIn = async (folder) => (await service.list(folder)).entries.filter((entry) => entry.hidden).map((entry) => entry.name);
  const shownIn = async (folder) => (await service.list(folder)).entries.filter((entry) => !entry.hidden).map((entry) => entry.name);

  assert.deepEqual(await hiddenIn('C:\\'), ['$Recycle.Bin', 'Documents and Settings', 'ProgramData', 'System Volume Information', 'pagefile.sys']);
  assert.deepEqual(await shownIn('C:\\'), ['Program Files', 'Users', 'Windows']);
  assert.deepEqual(await hiddenIn('C:\\Users'), ['All Users', 'Default']);
  assert.deepEqual(await hiddenIn(PROFILE), ['AppData', 'Application Data', 'NTUSER.DAT', 'ntuser.ini']);
  assert.deepEqual(await hiddenIn(WINDOWS_PLACES.documents), ['Mes images', 'desktop.ini']);
  // « Thumbs.db » est masqué partout ; un dossier « Thumbs » ne l'est pas.
  assert.deepEqual(await hiddenIn('D:\\'), ['Thumbs.db']);

  // Les mêmes noms ailleurs qu'à leur place habituelle ne sont pas masqués.
  const elsewhere = windowsService({}, { drives: { 'E:\\': { tree: { Sauvegarde: { ProgramData: {}, AppData: {}, Default: {}, 'Mes images': {}, '$data': {}, '.config': {} } } } } });
  assert.deepEqual((await elsewhere.service.list('E:\\Sauvegarde')).entries.filter((entry) => entry.hidden), []);
});

test('ailleurs que sous Windows, les éléments masqués sont ceux dont le nom commence par un point', async () => {
  const disk = createFakeFs({ platform: 'linux', drives: { '/': { totalBytes: 2e10, freeBytes: 1e10, tree: { home: { leo: { '.config': {}, '.profile': file(1), Documents: {}, 'Thumbs.db': file(1), 'desktop.ini': file(1) } } } } } });
  const service = createFilesService({ platform: 'linux', fs: disk.fs, drives: 'auto', places: { documents: '/home/leo/Documents' } });
  const found = await service.places();
  assert.deepEqual(found.drives, [{ id: '/', letter: null, path: '/', system: false, totalBytes: 2e10 - (2e10 % 4096), freeBytes: 1e10 - (1e10 % 4096) }]);
  const listing = await service.list('/home/leo');
  assert.deepEqual(listing.entries.filter((entry) => entry.hidden).map((entry) => entry.name), ['.config', '.profile']);
  assert.deepEqual(listing.root, { id: '/', kind: 'drive', path: '/' });
  assert.deepEqual(listing.trail, [{ name: 'home', path: '/home' }, { name: 'leo', path: '/home/leo' }]);
  assert.equal(entryOf(listing, 'Documents').place, 'documents');
});

test('un dossier personnel vu depuis son dossier parent porte son identité', async () => {
  const { service } = windowsService();
  const listing = await service.list(PROFILE);
  const tagged = Object.fromEntries(listing.entries.filter((entry) => entry.place).map((entry) => [entry.name, entry.place]));
  assert.deepEqual(tagged, { Desktop: 'desktop', Documents: 'documents', Downloads: 'downloads', Music: 'music', Pictures: 'pictures' });
  assert.equal(Object.hasOwn(entryOf(listing, 'AppData'), 'place'), false);
});

test('dossier très volumineux : la lecture s’arrête à la limite et le signale', async () => {
  const tree = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`fichier-${String(index).padStart(2, '0')}.txt`, file(index)]));
  const { disk, service } = windowsService({ limits: { entries: 12, probeMs: 200 } }, { drives: { 'E:\\': { tree: { Gros: tree, Juste: Object.fromEntries(Object.entries(tree).slice(0, 12)) } } } });
  await service.places();
  const before = disk.state.yielded;

  const listing = await service.list('E:\\Gros');
  assert.equal(listing.entries.length, 12);
  assert.equal(listing.truncated, true);
  assert.equal(listing.limit, 12);
  assert.deepEqual(namesOf(listing).slice(0, 2), ['fichier-00.txt', 'fichier-01.txt']);
  assert.equal(disk.state.yielded - before, 13, 'la lecture s’interrompt dès la limite atteinte');
  assert.equal(disk.state.openHandles, 0, 'le dossier est refermé malgré l’interruption');
  assert.equal(disk.pathsOf('lstat').filter((target) => target.startsWith('E:\\Gros\\')).length, 12);

  // Exactement à la limite : rien n'est tronqué.
  const exact = await service.list('E:\\Juste');
  assert.deepEqual([exact.entries.length, exact.truncated], [12, false]);
  assert.equal(DEFAULT_LIMITS.entries, 5000);
});

test('une même demande répétée pendant sa lecture n’est lue qu’une fois', async () => {
  const { disk, service } = windowsService();
  await service.places();
  const [first, second, third] = await Promise.all([service.list('C:\\Users'), service.list('c:/users/'), service.list('C:\\Users')]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
  assert.deepEqual(disk.pathsOf('opendir'), ['C:\\Users']);
  // Une fois la lecture terminée, une nouvelle demande relit le dossier (actualisation).
  await service.list('C:\\Users');
  assert.equal(disk.pathsOf('opendir').length, 2);
});

// ---------------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------------

test('dossier protégé, introuvable, fichier : un refus clair, sans détail interne', async () => {
  const { disk, service } = windowsService();
  const failures = [
    ['C:\\System Volume Information', 'access-denied', /Accès refusé/],
    ['C:\\$Recycle.Bin', 'access-denied', /Accès refusé/],
    ['C:\\Absent', 'not-found', /introuvable/],
    ['C:\\Users\\Léo\\Documents\\Absent\\Plus loin', 'not-found', /introuvable/],
    ['C:\\Windows\\win.ini', 'not-a-directory', /n'est pas un dossier/],
    ['C:\\Windows\\win.ini\\dessous', 'not-a-directory', /n'est pas un dossier/],
  ];
  for (const [target, code, message] of failures) {
    await assert.rejects(service.list(target), (error) => {
      assert.ok(error instanceof ServiceError, target);
      assert.equal(error.code, code, target);
      assert.match(error.message, message);
      // Ni chemin, ni code du système, ni nom de fonction.
      assert.doesNotMatch(error.message, /C:\\|EPERM|EACCES|ENOENT|ENOTDIR|opendir|realpath|lstat/);
      return true;
    });
  }
  assert.equal(disk.state.openHandles, 0);
});

test('chaque erreur du système est traduite ; une erreur inconnue signale un emplacement indisponible', async () => {
  const codes = { EPERM: 'access-denied', EACCES: 'access-denied', ENOENT: 'not-found', ENOTDIR: 'not-a-directory', ENAMETOOLONG: 'invalid-path', EIO: 'unavailable', EBUSY: 'unavailable', ELOOP: 'unavailable', EMFILE: 'unavailable', UNKNOWN: 'unavailable' };
  for (const [system, expected] of Object.entries(codes)) {
    for (const step of ['realpath', 'opendir']) {
      const { disk, service } = windowsService({}, { errors: { [step]: { 'D:\\Jeux': system } } });
      assert.equal(await refusal(service.list('D:\\Jeux')), expected, `${step} ${system}`);
      assert.equal(disk.state.openHandles, 0);
      // Le service reste utilisable après l'erreur.
      assert.equal((await service.list('D:\\')).path, 'D:\\');
    }
  }
  // Le constat préalable (dossier ou non) peut lui aussi échouer.
  const { service } = windowsService({}, { errors: { lstat: { 'D:\\Jeux': 'EIO' } } });
  assert.equal(await refusal(service.list('D:\\Jeux')), 'unavailable');
});

test('lecteur retiré après avoir été listé : refus, puis disparition à l’actualisation', async () => {
  const { disk, service } = windowsService({}, { drives: { 'E:\\': { tree: { DCIM: {} } } } });
  assert.deepEqual((await service.places()).drives.map((drive) => drive.id), ['C:', 'D:', 'E:']);
  assert.equal((await service.list('E:\\DCIM')).path, 'E:\\DCIM');

  disk.mutate((drives) => delete drives['E:\\']);
  assert.equal(await refusal(service.list('E:\\DCIM')), 'not-found');
  assert.deepEqual((await service.places()).drives.map((drive) => drive.id), ['C:', 'D:']);
  assert.equal(await refusal(service.list('E:\\DCIM')), 'outside-allowed');
});

// ---------------------------------------------------------------------------------
// Lecteurs
// ---------------------------------------------------------------------------------

test('capacité d’un lecteur : inconnue si elle ne peut pas être lue ou si elle est incohérente', async () => {
  const { service } = windowsService({}, {
    drives: {
      'E:\\': { tree: {}, statfs: 'EIO' },
      'F:\\': { tree: {}, totalBytes: 0, freeBytes: 0 },
      'G:\\': { tree: {}, totalBytes: 4096 * 10, freeBytes: 4096 * 50 },
    },
  });
  const drives = Object.fromEntries((await service.places()).drives.map((drive) => [drive.id, [drive.totalBytes, drive.freeBytes]]));
  assert.deepEqual(drives, { 'C:': [512_000_000_000, 128_000_000_000], 'D:': [1_000_000_000_000, 409_600_000_000], 'E:': [null, null], 'F:': [null, null], 'G:': [null, null] });
});

test('liste de lecteurs imposée : seuls ceux-là sont interrogés ; les désignations invalides sont ignorées', async () => {
  const { disk, service } = windowsService({ drives: ['d:/', 'D:\\', 'C:\\Users', 'Z:\\', '\\\\nas\\partage\\', 'Q:\\', 42, null, 'C:'] });
  const found = await service.places();
  assert.deepEqual(found.drives.map((drive) => drive.id), ['D:']);
  assert.deepEqual(disk.pathsOf('realpath').filter((target) => /^[A-Z]:\\$/.test(target)).sort(), ['D:\\', 'Q:\\', 'Z:\\']);
  // Lecteurs imposés : un dossier personnel situé sur un autre lecteur reste consultable.
  assert.equal(found.places.filter((place) => place.available).length, 5);
  assert.equal(await refusal(service.list('C:\\Windows')), 'outside-allowed');
  assert.equal((await service.list(WINDOWS_PLACES.documents)).root.kind, 'place');
});

test('lecteur du système : reconnu par la variable SystemDrive, sinon aucun', async () => {
  const flagged = async (env) => {
    const { service } = windowsService({ env });
    return (await service.places()).drives.filter((drive) => drive.system).map((drive) => drive.id);
  };
  assert.deepEqual(await flagged({ SystemDrive: 'C:' }), ['C:']);
  assert.deepEqual(await flagged({ SystemDrive: 'd:' }), ['D:']);
  assert.deepEqual(await flagged({}), []);
  assert.deepEqual(await flagged({ SystemDrive: 'C:\\Windows' }), []);
});

test('lecteur qui ne répond pas : la recherche aboutit quand même, sans lui, dans le délai prévu', async () => {
  const { disk, service } = windowsService({ limits: { probeMs: 40 } }, { drives: { 'E:\\': { tree: { DCIM: {} } } }, hang: ['E:\\'] });
  const started = Date.now();
  const found = await service.places();
  assert.ok(Date.now() - started < 2_000, 'aucun blocage');
  assert.deepEqual(found.drives.map((drive) => drive.id), ['C:', 'D:']);
  assert.equal(disk.pending(), 1, 'la demande faite au lecteur muet reste en attente');
  // Les autres lettres ont toutes été interrogées par la seconde file.
  assert.equal(disk.pathsOf('realpath').filter((target) => /^[A-Z]:\\$/.test(target)).length, 26);

  // Tant qu'il n'a pas répondu, il n'est pas interrogé de nouveau : jamais deux demandes pour le même lecteur.
  await service.places();
  await service.places();
  assert.equal(disk.pathsOf('realpath').filter((target) => target === 'E:\\').length, 1);
  assert.equal(disk.pending(), 1);
  assert.equal(await refusal(service.list('E:\\DCIM')), 'outside-allowed');

  // Il finit par répondre : sa réponse tardive est retenue, il apparaît à la recherche suivante.
  disk.release('E:\\');
  await sleep(20);
  assert.deepEqual((await service.places()).drives.map((drive) => drive.id), ['C:', 'D:', 'E:']);
  assert.equal((await service.list('E:\\DCIM')).path, 'E:\\DCIM');
});

test('lecteurs muets : jamais plus de deux demandes en attente, quoi qu’il arrive', async () => {
  const mute = ['F:\\', 'G:\\', 'H:\\', 'X:\\'];
  const { disk, service } = windowsService({ limits: { probeMs: 30 } }, { drives: Object.fromEntries(mute.map((root) => [root, { tree: {} }])), hang: mute });
  assert.equal(DEFAULT_LIMITS.probes, 2);

  for (let round = 0; round < 4; round += 1) {
    const found = await service.places();
    assert.ok(disk.pending() <= 2, `tour ${round} : ${disk.pending()} demandes en attente`);
    assert.deepEqual(found.drives.map((drive) => drive.id), ['C:', 'D:'], 'les lecteurs déjà trouvés restent listés');
  }
  // Les deux premières lettres muettes occupent les deux places : les suivantes attendent leur tour.
  assert.deepEqual(disk.pathsOf('realpath').filter((target) => mute.includes(target)), ['F:\\', 'G:\\']);
  // Les lectures de dossiers, elles, ne sont pas retardées.
  assert.equal((await service.list('C:\\Users')).path, 'C:\\Users');

  // Les lecteurs répondent enfin (ici : ils existent) ; la recherche reprend là où elle s'était arrêtée.
  for (const root of mute) disk.release(root);
  await sleep(20);
  const found = await service.places();
  assert.deepEqual(found.drives.map((drive) => drive.id), ['C:', 'D:', 'F:', 'G:', 'H:', 'X:']);
  assert.equal(disk.pending(), 0);
});

test('un lecteur lent n’est plus attendu : interrogé à part, il revient dès qu’il répond à temps', async () => {
  const { disk, service } = windowsService({ limits: { probeMs: 300 } }, { drives: { 'E:\\': { tree: {} } }, hang: ['E:\\'] });
  await service.places(); // E: ne répond pas dans le délai : noté « lent »
  disk.release('E:\\'); // la demande en attente aboutit…
  disk.silence('E:\\'); // … mais le lecteur redevient muet
  await sleep(20);

  const started = Date.now();
  const found = await service.places();
  // Lent : interrogé en arrière-plan, sans que la recherche l'attende (le délai est de 300 ms).
  assert.ok(Date.now() - started < 200, `recherche retardée de ${Date.now() - started} ms`);
  assert.deepEqual(found.drives.map((drive) => drive.id), ['C:', 'D:', 'E:'], 'son dernier état connu est conservé');
  assert.equal(disk.pending(), 1);

  disk.release('E:\\');
  await sleep(40);
  // Il a répondu à temps : il est de nouveau interrogé avec les autres.
  const before = disk.pathsOf('realpath').filter((target) => target === 'E:\\').length;
  await service.places();
  assert.equal(disk.pathsOf('realpath').filter((target) => target === 'E:\\').length, before + 1);
  assert.equal(disk.pending(), 0);
});

test('dossier personnel qui ne répond pas : déclaré indisponible, sans bloquer les autres', async () => {
  const { disk, service } = windowsService({ limits: { probeMs: 40 } }, { hang: [WINDOWS_PLACES.documents] });
  const started = Date.now();
  const found = await service.places();
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(found.places.filter((place) => !place.available).map((place) => place.id), ['documents', 'videos']);
  assert.equal(found.drives.length, 2);
  // Une seule demande reste en attente pour ce dossier, même après plusieurs recherches.
  await service.places();
  assert.equal(disk.pending(), 1);
  disk.release(WINDOWS_PLACES.documents);
  await sleep(20);
  assert.equal((await service.places()).places.find((place) => place.id === 'documents').available, true);
});

test('deux recherches simultanées n’en font qu’une', async () => {
  const { disk, service } = windowsService();
  const [first, second] = await Promise.all([service.places(), service.places()]);
  assert.deepEqual(first, second);
  assert.equal(disk.pathsOf('realpath').filter((target) => target === 'C:\\').length, 1);
  // La recherche suivante interroge de nouveau les lecteurs (un lecteur a pu être branché).
  await service.places();
  assert.equal(disk.pathsOf('realpath').filter((target) => target === 'C:\\').length, 2);
});

// ---------------------------------------------------------------------------------
// Point d'accès des services
// ---------------------------------------------------------------------------------

test('par le point d’accès : deux méthodes, des refus codés, aucune opération d’écriture', async () => {
  const disk = windowsDisk();
  const services = createServices({ files: { platform: 'win32', fs: disk.fs, env: { SystemDrive: 'C:' }, places: WINDOWS_PLACES, drives: 'auto' } });
  const call = (method, ...args) => services.hub.call('files', method, args, { origin: 'test' });

  assert.deepEqual(services.describe().files, { state: 'available', access: 'read-only', places: null, drives: null, methods: ['places', 'list'], events: [] });
  const places = await call('places');
  assert.equal(places.ok, true);
  assert.equal(places.value.drives.length, 2);
  assert.deepEqual(services.describe().files, { state: 'available', access: 'read-only', places: 5, drives: 2, methods: ['places', 'list'], events: [] });

  const listing = await call('list', WINDOWS_PLACES.desktop);
  assert.equal(listing.ok, true);
  assert.deepEqual(namesOf(listing.value), ['Notes.txt']);

  const refusals = [
    [['..'], 'invalid-path'],
    [['\\\\nas\\partage'], 'invalid-path'],
    [['Z:\\Films'], 'outside-allowed'],
    [['C:\\System Volume Information'], 'access-denied'],
    [['C:\\Absent'], 'not-found'],
    [['C:\\Windows\\win.ini'], 'not-a-directory'],
    [[], 'invalid-path'],
    [[{ path: 'C:\\' }], 'invalid-path'],
  ];
  for (const [args, code] of refusals) {
    const reply = await call('list', ...args);
    assert.deepEqual([reply.ok, reply.code], [false, code], JSON.stringify(args));
    assert.equal(typeof reply.message, 'string');
  }

  const before = disk.calls.length;
  for (const method of ['write', 'writeFile', 'create', 'mkdir', 'rename', 'move', 'copy', 'delete', 'remove', 'unlink', 'trash', 'open', 'read', 'readFile', 'status', 'constructor', '__proto__', 'toString']) {
    const reply = await call(method, WINDOWS_PLACES.desktop, 'contenu');
    assert.deepEqual([reply.ok, reply.code], [false, 'unknown-method'], method);
  }
  assert.equal(disk.calls.length, before, 'une méthode inconnue ne touche pas au disque');
});

test('sans emplacement indiqué par l’hôte, rien n’est consultable', async () => {
  const services = createServices();
  const places = await services.hub.call('files', 'places', [], { origin: 'test' });
  assert.equal(places.ok, true);
  assert.deepEqual(places.value, { places: PLACE_IDS.map((id) => ({ id, path: null, available: false })), drives: [] });
  for (const target of [process.cwd(), tmpdir(), path.parse(process.cwd()).root]) {
    const reply = await services.hub.call('files', 'list', [target], { origin: 'test' });
    assert.deepEqual([reply.ok, reply.code], [false, 'outside-allowed'], target);
  }
});

// ---------------------------------------------------------------------------------
// Vrai disque (dossier temporaire)
// ---------------------------------------------------------------------------------

const workDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'evolve-files-')));
after(() => {
  try {
    chmodSync(path.join(workDir, 'profil', 'Documents', 'Privé'), 0o755);
  } catch {
    /* dossier absent : rien à rétablir */
  }
  rmSync(workDir, { recursive: true, force: true });
});

const home = path.join(workDir, 'profil');
const documents = path.join(home, 'Documents');
const outside = path.join(workDir, 'ailleurs');
mkdirSync(path.join(documents, "Dossier d'été 2026", 'Sous-dossier vide'), { recursive: true });
mkdirSync(path.join(home, 'Images'));
mkdirSync(outside);
writeFileSync(path.join(documents, 'Rapport final.txt'), Buffer.alloc(1536, 3));
writeFileSync(path.join(documents, '.masque'), '');
writeFileSync(path.join(documents, 'Thumbs.db'), '');
writeFileSync(path.join(documents, "Dossier d'été 2026", 'plage.jpg'), Buffer.alloc(2048, 7));
writeFileSync(path.join(outside, 'secret.txt'), 'hors des emplacements autorisés');
utimesSync(path.join(documents, 'Rapport final.txt'), new Date(MARCH), new Date(MARCH));

/** Liens symboliques : leur création peut être refusée (Windows sans droit particulier). */
let linksCreated = true;
try {
  symlinkSync(path.join(home, 'Images'), path.join(documents, 'Vers Images'), 'junction');
  symlinkSync(outside, path.join(documents, 'Vers ailleurs'), 'junction');
} catch {
  linksCreated = false;
}

/** État complet d'un dossier : noms, tailles, dates et empreintes des contenus. */
function snapshot(folder) {
  const lines = [];
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, item.name);
      const info = lstatSync(full);
      if (item.isDirectory()) {
        lines.push(`${path.relative(folder, full)}/ ${Math.round(info.mtimeMs)}`);
        walk(full);
      } else if (item.isSymbolicLink()) {
        lines.push(`${path.relative(folder, full)} -> lien`);
      } else {
        lines.push(`${path.relative(folder, full)} ${info.size} ${Math.round(info.mtimeMs)} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
      }
    }
  })(folder);
  return lines.join('\n');
}

const realService = () => createFilesService({ places: { documents, pictures: path.join(home, 'Images'), music: path.join(home, 'Musique absente') } });

test('vrai disque : contenu réel d’un dossier, noms accentués, tailles et dates exactes', async () => {
  const service = realService();
  const found = await service.places();
  assert.deepEqual(found.drives, []);
  assert.deepEqual(found.places.filter((place) => place.available), [
    { id: 'documents', path: documents, available: true },
    { id: 'pictures', path: path.join(home, 'Images'), available: true },
  ]);

  const listing = await service.list(documents);
  assert.equal(listing.path, documents);
  assert.deepEqual(listing.root, { id: 'documents', kind: 'place', path: documents });
  const expected = ['.masque', "Dossier d'été 2026", 'Rapport final.txt', 'Thumbs.db', ...(linksCreated ? ['Vers Images', 'Vers ailleurs'] : [])];
  assert.deepEqual(namesOf(listing).sort(), [...expected].sort());

  assert.deepEqual(entryOf(listing, 'Rapport final.txt'), { name: 'Rapport final.txt', path: path.join(documents, 'Rapport final.txt'), kind: 'file', size: 1536, modified: MARCH, hidden: false });
  assert.equal(entryOf(listing, "Dossier d'été 2026").kind, 'folder');
  // Un seul des deux est masqué, selon le système : le nom à point ailleurs, « Thumbs.db » sous Windows.
  const hidden = listing.entries.filter((entry) => entry.hidden).map((entry) => entry.name);
  assert.deepEqual(hidden, [process.platform === 'win32' ? 'Thumbs.db' : '.masque']);

  const sub = await service.list(path.join(documents, "Dossier d'été 2026"));
  assert.deepEqual(sub.trail, [{ name: "Dossier d'été 2026", path: path.join(documents, "Dossier d'été 2026") }]);
  assert.deepEqual(namesOf(sub).sort(), ['Sous-dossier vide', 'plage.jpg']);
  assert.deepEqual((await service.list(path.join(documents, "Dossier d'été 2026", 'Sous-dossier vide'))).entries, []);
});

test('vrai disque : refus hors des emplacements, fichier, dossier introuvable', async () => {
  const service = realService();
  assert.equal(await refusal(service.list(home)), 'outside-allowed');
  assert.equal(await refusal(service.list(outside)), 'outside-allowed');
  assert.equal(await refusal(service.list(workDir)), 'outside-allowed');
  assert.equal(await refusal(service.list(`${documents}${path.sep}..${path.sep}ailleurs`)), 'invalid-path');
  assert.equal(await refusal(service.list(`${documents}${path.sep}..`)), 'invalid-path');
  assert.equal(await refusal(service.list(path.join(documents, 'Rapport final.txt'))), 'not-a-directory');
  assert.equal(await refusal(service.list(path.join(documents, 'Introuvable'))), 'not-found');
  assert.equal(await refusal(service.list(path.join(home, 'Musique absente'))), 'outside-allowed');
});

test('vrai disque : un lien est décrit sans être suivi ; il ne s’ouvre que vers un emplacement autorisé', { skip: linksCreated ? false : 'création de liens refusée sur cette machine' }, async () => {
  const service = realService();
  const listing = await service.list(documents);
  for (const name of ['Vers Images', 'Vers ailleurs']) {
    assert.deepEqual([entryOf(listing, name).kind, entryOf(listing, name).size], ['link', null], name);
  }
  const followed = await service.list(path.join(documents, 'Vers Images'));
  assert.equal(followed.path, path.join(home, 'Images'));
  assert.equal(followed.root.id, 'pictures');
  assert.equal(await refusal(service.list(path.join(documents, 'Vers ailleurs'))), 'leads-outside');
});

test('vrai disque : dossier dont l’accès est refusé par le système', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'droits non applicables ici' : false }, async () => {
  const locked = path.join(documents, 'Privé');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const service = realService();
    assert.equal(await refusal(service.list(locked)), 'access-denied');
    // Le dossier parent reste lisible ; le dossier fermé y figure.
    assert.equal(entryOf(await service.list(documents), 'Privé').kind, 'folder');
  } finally {
    chmodSync(locked, 0o755);
    rmSync(locked, { recursive: true, force: true });
  }
});

test('vrai disque : une visite complète ne modifie rien — contenus, tailles et dates identiques', async () => {
  const before = snapshot(workDir);
  const service = realService();
  await service.places();
  const visit = async (folder) => {
    const listing = await service.list(folder);
    for (const entry of listing.entries) {
      if (entry.kind === 'folder') await visit(entry.path);
      else if (entry.kind === 'link') await refusal(service.list(entry.path));
    }
  };
  await visit(documents);
  await visit(path.join(home, 'Images'));
  for (const target of [outside, path.join(documents, 'Rapport final.txt'), path.join(documents, 'Introuvable')]) await refusal(service.list(target));
  assert.equal(snapshot(workDir), before);
});
