/**
 * Tests des opérations sur les fichiers (src/services/file-operations.js),
 * sur le faux disque d'un PC sous Windows : lettres de lecteur, noms
 * insensibles à la casse, jonctions, lecteur réseau, dossiers du système.
 *
 * Ce faux disque note chaque appel reçu et, comme un vrai, laisse `rename`
 * et `copyFile` remplacer un fichier existant : tout écrasement serait vu
 * (`disk.overwritten`). La Corbeille y est simulée (`disk.recycle`) — c'est
 * la seule façon dont un élément peut quitter le disque.
 *
 * Les mêmes opérations sont éprouvées sur un vrai disque dans
 * tests/file-operations-disk.test.mjs.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { readText, stripComments } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createFilesService } = require('../src/services/files.js');
const { createFileOperations, WRITE_CALLS, READ_CALLS, COLLISION_POLICIES, RUNS_CODE, OPENS_AS_CONTENT } = require('../src/services/file-operations.js');
const { ServiceError } = require('../src/services/hub.js');
const { createFakeFs, file, link } = require('./fixtures/fake-fs.cjs');

const PROFILE = 'C:\\Users\\Léo';
const DOCS = `${PROFILE}\\Documents`;
const DESKTOP = `${PROFILE}\\Desktop`;
const PLACES = Object.freeze({
  desktop: DESKTOP,
  documents: DOCS,
  downloads: `${PROFILE}\\Downloads`,
  pictures: `${PROFILE}\\Pictures`,
  music: `${PROFILE}\\Music`,
  videos: `${PROFILE}\\Videos`, // absent du disque
});
const ENV = Object.freeze({
  SystemDrive: 'C:',
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  APPDATA: `${PROFILE}\\AppData\\Roaming`,
  LOCALAPPDATA: `${PROFILE}\\AppData\\Local`,
});

/** Faux PC : un profil, des dossiers du système, un second disque, un partage réseau et la lettre qui y mène. */
function pc({ errors, trash, openPath, limits, wrap, listedLinks } = {}) {
  const disk = createFakeFs({
    platform: 'win32',
    errors,
    listedLinks,
    drives: {
      'C:\\': {
        totalBytes: 512e9,
        freeBytes: 128e9,
        tree: {
          '$Recycle.Bin': {},
          'Program Files': { Outil: { 'outil.exe': file(1000) } },
          ProgramData: { Partage: { 'données.bin': file(5) } },
          Windows: { 'win.ini': file(92), System32: { 'cmd.exe': file(300) } },
          'pagefile.sys': file(1000),
          Users: {
            Public: { 'lisezmoi.txt': file(4) },
            Léo: {
              AppData: { Roaming: { Evolve: { 'settings.json': file(246) } }, Local: { Temp: {} } },
              Desktop: { 'Notes.txt': file(7), 'Jeu.lnk': file(900) },
              Documents: {
                'Budget.xlsx': file(48_300),
                'Lettre.txt': file(120),
                'programme.exe': file(5000),
                Projets: { 'plan.pdf': file(3), Été: { 'photo.jpg': file(2048), 'Vers Windows': link('C:\\Windows') } },
                Archives: {},
                'Vers Windows': link('C:\\Windows'),
                'Vers le NAS': link('\\\\nas\\partage\\Documents'),
                'Vers Images': link(`${PROFILE}\\Pictures`),
                'Vers Projets': link(`${DOCS}\\Projets`),
              },
              Downloads: { 'setup.msi': file(10) },
              Pictures: { 'fond.png': file(3_100_000) },
              Music: {},
            },
          },
        },
      },
      'D:\\': { totalBytes: 1e12, freeBytes: 4e11, tree: { Sauvegardes: {}, 'Lettre.txt': file(999), Films: { 'film.mkv': file(7_000_000) } } },
      '\\\\nas\\partage\\': { tree: { Documents: { 'secret.txt': file(1) } } },
      'Z:\\': { target: '\\\\nas\\partage\\', tree: { Documents: { 'secret.txt': file(1) } } },
    },
  });
  const files = createFilesService({ platform: 'win32', places: PLACES, drives: 'auto', fs: disk.fs, env: ENV });
  const opened = [];
  const operations = createFileOperations({
    guard: files.guard,
    fs: wrap ? wrap(disk) : disk.fs,
    env: ENV,
    trash: trash === undefined ? disk.recycle : trash,
    openPath: openPath ?? (async (target) => (opened.push(target), '')),
    limits,
  });
  return { disk, files, operations, opened };
}

/** Code de l'erreur de service par laquelle `promise` doit échouer. */
async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, `erreur inattendue : ${error?.stack ?? error}`);
    assert.ok(error.message.length > 10, 'message lisible');
    return error.code;
  }
  return assert.fail('la demande aurait dû être refusée');
}

const namesIn = async (files, folder) => (await files.list(folder)).entries.map((entry) => entry.name).sort();
const CONFIRMED = Object.freeze({ confirmed: true });

// ---------------------------------------------------------------------------------
// Ce que le module peut faire au disque
// ---------------------------------------------------------------------------------

test('le module ne dispose que de trois fonctions qui modifient le disque : créer un dossier, renommer, copier un fichier', () => {
  assert.deepEqual(WRITE_CALLS, ['mkdir', 'rename', 'copyFile']);
  assert.deepEqual(READ_CALLS, ['lstat', 'opendir', 'realpath']);
  assert.ok(Object.isFrozen(WRITE_CALLS) && Object.isFrozen(READ_CALLS));
  // « Remplacer » n'est pas un choix possible.
  assert.deepEqual(COLLISION_POLICIES, ['ask', 'keep-both', 'skip']);

  const code = stripComments(readText('src', 'services', 'file-operations.js'));
  // Le module de fichiers n'est atteint que par « disk », construit à partir de ces six fonctions.
  const viaDisk = new Set([...code.matchAll(/\bdisk\.(\w+)/g)].map((match) => match[1]));
  assert.deepEqual([...viaDisk].sort(), [...READ_CALLS, ...WRITE_CALLS, 'exclusive'].sort());
  const viaModule = new Set([...code.matchAll(/\bfs\.(\w+)/g)].map((match) => match[1]));
  assert.deepEqual([...viaModule].sort(), [...READ_CALLS, ...WRITE_CALLS, 'constants'].sort());
  assert.match(code, /exclusive: fs\.constants\.COPYFILE_EXCL,/);
  // Le module de Node lui-même n'est que la valeur par défaut de l'option « fs ».
  assert.deepEqual([...code.matchAll(/\bnodeFs\b/g)].length, 2);
  assert.doesNotMatch(code, /node:fs\/promises|\bfs\s*\[/);
  // Aucune fonction de suppression, d'écriture de contenu, de lecture de contenu ni de lancement de programme — sous aucune forme.
  assert.doesNotMatch(code, /\b(?:rm|rmdir|unlink|truncate|ftruncate|writeFile|appendFile|createWriteStream|createReadStream|readFile|open|write|read|cp|symlink|link|chmod|chown|utimes|mkdtemp)(?:Sync)?\s*\(/);
  assert.doesNotMatch(code, /child_process|\bexec\(|\bspawn\(|require\('electron'\)/);
  // Chaque copie de fichier est exclusive : le système la refuse si le nom existe.
  const copies = [...code.matchAll(/disk\.copyFile\(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(copies.length, 2);
  for (const call of copies) assert.match(call, /, disk\.exclusive$/);
  // Aucune création de dossier récursive (elle réussirait sur un dossier existant).
  assert.doesNotMatch(code, /recursive/);
});

test('une session complète ne touche que les six fonctions prévues du système de fichiers', async () => {
  const { disk, operations } = pc();
  await operations.createFolder(DOCS, 'Factures');
  await operations.rename(`${DOCS}\\Lettre.txt`, 'Courrier.txt');
  await operations.copy([`${DOCS}\\Projets`, `${DOCS}\\Budget.xlsx`], `${DOCS}\\Archives`);
  await operations.move([`${DOCS}\\Courrier.txt`], `${DOCS}\\Factures`, CONFIRMED);
  await operations.move([`${DOCS}\\Budget.xlsx`], 'D:\\Sauvegardes', CONFIRMED);
  await operations.trash([`${DOCS}\\programme.exe`], CONFIRMED);
  await operations.open(`${DESKTOP}\\Notes.txt`);
  // « statfs » : recherche des lecteurs par le service de consultation, qui partage ce faux disque.
  assert.deepEqual([...disk.touched].sort(), [...READ_CALLS, ...WRITE_CALLS, 'constants', 'statfs'].sort());
  assert.deepEqual(disk.overwritten, []);
});

// ---------------------------------------------------------------------------------
// Nouveau dossier
// ---------------------------------------------------------------------------------

test('nouveau dossier : créé dans le dossier ouvert, à son emplacement réel', async () => {
  const { disk, files, operations } = pc();
  assert.deepEqual(await operations.createFolder(DOCS, 'Factures 2026'), { path: `${DOCS}\\Factures 2026`, name: 'Factures 2026' });
  const entry = (await files.list(DOCS)).entries.find((item) => item.name === 'Factures 2026');
  assert.equal(entry.kind, 'folder');
  assert.deepEqual(disk.writes(), [['mkdir', `${DOCS}\\Factures 2026`]]);

  // Un lecteur ou un dossier personnel peut recevoir un dossier.
  assert.equal((await operations.createFolder('D:\\', 'Nouveau dossier')).path, 'D:\\Nouveau dossier');
  assert.equal((await operations.createFolder('c:/users/léo/desktop/', 'Été 2026')).path, `${DESKTOP}\\Été 2026`);
  // À travers une jonction qui mène à un emplacement autorisé : le dossier est créé là où elle mène.
  assert.equal((await operations.createFolder(`${DOCS}\\Vers Images`, 'Album')).path, `${PROFILE}\\Pictures\\Album`);
  assert.ok((await namesIn(files, `${PROFILE}\\Pictures`)).includes('Album'));
  assert.deepEqual(disk.overwritten, []);
});

test('nouveau dossier : nom déjà pris, nom refusé, dossier absent — rien n’est créé', async () => {
  const { disk, operations } = pc();
  const before = disk.snapshot();
  // Un fichier ou un dossier porte déjà ce nom (la casse ne compte pas sous Windows).
  for (const name of ['Projets', 'budget.XLSX', 'Vers Windows']) assert.equal(await codeOf(operations.createFolder(DOCS, name)), 'collision', name);
  const invalid = ['', '   ', 'a/b', 'a\\b', '.', '..', '. .', 'CON', 'nul.txt', 'COM1', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'fin.', 'fin ', ' début', 'x'.repeat(256), 'a\u0000b', 'a\nb'];
  for (const name of invalid) assert.equal(await codeOf(operations.createFolder(DOCS, name)), 'invalid-name', JSON.stringify(name));
  for (const name of [42, null, undefined, {}, ['x']]) assert.equal(await codeOf(operations.createFolder(DOCS, name)), 'invalid-name', String(name));
  for (const parent of [42, null, undefined, {}, ['x']]) assert.equal(await codeOf(operations.createFolder(parent, 'x')), 'bad-arguments');
  assert.equal(await codeOf(operations.createFolder(`${DOCS}\\Absent`, 'x')), 'not-found');
  assert.equal(await codeOf(operations.createFolder(`${DOCS}\\Lettre.txt`, 'x')), 'not-a-directory');
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes().filter(([name]) => name !== 'mkdir'), []);
});

// ---------------------------------------------------------------------------------
// Renommer
// ---------------------------------------------------------------------------------

test('renommer : un fichier, puis un dossier avec tout son contenu', async () => {
  const { disk, files, operations } = pc();
  assert.deepEqual(await operations.rename(`${DOCS}\\Lettre.txt`, 'Courrier de mars.txt'), { path: `${DOCS}\\Courrier de mars.txt`, name: 'Courrier de mars.txt' });
  assert.deepEqual(await operations.rename(`${DOCS}\\Projets`, 'Projets 2026'), { path: `${DOCS}\\Projets 2026`, name: 'Projets 2026' });
  const names = await namesIn(files, DOCS);
  assert.ok(names.includes('Courrier de mars.txt') && names.includes('Projets 2026'));
  assert.ok(!names.includes('Lettre.txt') && !names.includes('Projets'));
  assert.deepEqual(await namesIn(files, `${DOCS}\\Projets 2026`), ['plan.pdf', 'Été']);
  assert.deepEqual(disk.writes(), [
    ['rename', `${DOCS}\\Lettre.txt`, `${DOCS}\\Courrier de mars.txt`],
    ['rename', `${DOCS}\\Projets`, `${DOCS}\\Projets 2026`],
  ]);

  // Même nom : rien à faire. Seule la casse change : c'est le même élément, renommé.
  assert.deepEqual(await operations.rename(`${DOCS}\\Budget.xlsx`, 'Budget.xlsx'), { path: `${DOCS}\\Budget.xlsx`, name: 'Budget.xlsx', unchanged: true });
  assert.deepEqual(await operations.rename(`${DOCS}\\Budget.xlsx`, 'BUDGET.xlsx'), { path: `${DOCS}\\BUDGET.xlsx`, name: 'BUDGET.xlsx' });
  assert.ok((await namesIn(files, DOCS)).includes('BUDGET.xlsx'));
  // Un chemin écrit autrement désigne le même élément : c'est son nom réel qui est renommé.
  assert.equal((await operations.rename('c:/users/LÉO/documents/budget.XLSX', 'Comptes.xlsx')).path, `${DOCS}\\Comptes.xlsx`);
  assert.deepEqual(disk.overwritten, []);
});

test('renommer : jamais vers un nom déjà pris — aucun fichier n’est remplacé', async () => {
  const { disk, operations } = pc();
  const before = disk.snapshot();
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Lettre.txt`, 'Budget.xlsx')), 'collision');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Lettre.txt`, 'BUDGET.XLSX')), 'collision');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Lettre.txt`, 'archives')), 'collision');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Projets`, 'Lettre.txt')), 'collision');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Lettre.txt`, 'Vers Windows')), 'collision');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Lettre.txt`, 'a/b.txt')), 'invalid-name');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Lettre.txt`, '..\\Desktop\\Lettre.txt')), 'invalid-name');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Absent.txt`, 'x.txt')), 'not-found');
  assert.equal(await codeOf(operations.rename(42, 'x.txt')), 'bad-arguments');
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes(), []);
  assert.deepEqual(disk.overwritten, []);
});

// ---------------------------------------------------------------------------------
// Copier
// ---------------------------------------------------------------------------------

test('copier : un fichier et un dossier complet — les originaux restent, les liens sont laissés de côté', async () => {
  const { disk, files, operations } = pc();
  const report = await operations.copy([`${DOCS}\\Lettre.txt`, `${DOCS}\\Projets`], `${DOCS}\\Archives`);
  assert.equal(report.status, 'done');
  assert.deepEqual(report.done, [
    { source: `${DOCS}\\Lettre.txt`, name: 'Lettre.txt', path: `${DOCS}\\Archives\\Lettre.txt` },
    { source: `${DOCS}\\Projets`, name: 'Projets', path: `${DOCS}\\Archives\\Projets` },
  ]);
  assert.deepEqual([report.skipped, report.failed, report.cancelled], [[], [], false]);
  // Le lien « Vers Windows », dans le sous-dossier, n'a été ni suivi ni copié.
  assert.equal(report.links, 1);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Archives`), ['Lettre.txt', 'Projets']);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Archives\\Projets`), ['plan.pdf', 'Été']);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Archives\\Projets\\Été`), ['photo.jpg']);
  const copy = (await files.list(`${DOCS}\\Archives\\Projets\\Été`)).entries[0];
  assert.deepEqual([copy.kind, copy.size], ['file', 2048]);
  // Les originaux sont intacts.
  assert.deepEqual(await namesIn(files, `${DOCS}\\Projets\\Été`), ['Vers Windows', 'photo.jpg']);
  assert.ok((await namesIn(files, DOCS)).includes('Lettre.txt'));
  // Chaque fichier a été copié en mode exclusif ; rien n'a été lu dans le dossier de Windows.
  const copies = disk.calls.filter(([name]) => name === 'copyFile');
  assert.equal(copies.length, 3);
  for (const [, , , flags] of copies) assert.equal(flags, 1);
  assert.ok(disk.calls.every(([, target]) => !/^C:\\Windows/i.test(target)), 'le lien n’a pas été suivi');
  assert.deepEqual(disk.overwritten, []);
});

test('copier un dossier : un lien qu’il contient n’est ni ouvert ni traversé — pas même pour compter les éléments', async () => {
  // Sous Windows, la lecture d'un dossier annonce une jonction comme un dossier ordinaire ou comme
  // un lien, selon la version de Node : le résultat doit être le même dans les deux cas.
  for (const listedLinks of ['as-folders', 'as-links']) {
    const { disk, files, operations } = pc({ listedLinks, limits: { progressMs: 0 } });
    const events = [];
    operations.on((event) => events.push(event));
    const before = disk.calls.length;

    const report = await operations.copy([`${DOCS}\\Projets`], `${DOCS}\\Archives`, { operation: 'copie' });
    assert.deepEqual([report.status, report.links, report.failed, report.cancelled], ['done', 1, [], false], listedLinks);

    // Le lien « Vers Windows » n'a été ni ouvert comme un dossier, ni traversé : seules ses propriétés ont été lues.
    const through = disk.calls.slice(before).filter(([, target]) => /\\Vers Windows(\\|$)/i.test(target));
    assert.ok(through.length > 0, 'le lien a bien été rencontré');
    assert.deepEqual([...new Set(through.map(([name]) => name))], ['lstat'], `${listedLinks} : ${JSON.stringify(through)}`);
    assert.ok(disk.calls.slice(before).every(([, target]) => !/^C:\\Windows/i.test(target)), listedLinks);

    // Le décompte annoncé est celui des éléments réellement copiés : Projets, plan.pdf, Été, photo.jpg.
    const running = events.filter((event) => event.state === 'running');
    assert.deepEqual(running.map((event) => [event.done, event.total]), [[1, 4], [2, 4], [3, 4], [4, 4]], listedLinks);
    assert.deepEqual(await namesIn(files, `${DOCS}\\Archives\\Projets\\Été`), ['photo.jpg'], listedLinks);
    assert.deepEqual(disk.overwritten, []);
  }
});

test('copier dans le dossier d’origine : une copie « - Copie », puis « - Copie (2) »', async () => {
  const { files, operations } = pc();
  const first = await operations.copy([`${DOCS}\\Lettre.txt`, `${DOCS}\\Projets`], DOCS);
  assert.deepEqual(first.done.map((item) => item.name), ['Lettre - Copie.txt', 'Projets - Copie']);
  const second = await operations.copy([`${DOCS}\\Lettre.txt`], DOCS);
  assert.deepEqual(second.done.map((item) => item.name), ['Lettre - Copie (2).txt']);
  const names = await namesIn(files, DOCS);
  for (const name of ['Lettre.txt', 'Lettre - Copie.txt', 'Lettre - Copie (2).txt', 'Projets', 'Projets - Copie']) assert.ok(names.includes(name), name);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Projets - Copie`), ['plan.pdf', 'Été']);
  // Aucun dossier provisoire ne subsiste.
  assert.ok(names.every((name) => !/copie en cours|copie incomplète/.test(name)));
});

test('copier : nom déjà pris à destination — la question est posée et rien n’est modifié ; puis « ignorer » ou « conserver les deux »', async () => {
  const { disk, files, operations } = pc();
  const sources = [`${DOCS}\\Lettre.txt`, `${DOCS}\\Budget.xlsx`];
  const before = disk.snapshot();
  const asked = await operations.copy(sources, 'D:\\');
  assert.deepEqual(asked, { status: 'collisions', operation: 'copy', destination: 'D:\\', collisions: [{ source: `${DOCS}\\Lettre.txt`, name: 'Lettre.txt' }], count: 2 });
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes(), []);

  // « Ignorer » : seul l'élément sans conflit est copié.
  const skipped = await operations.copy(sources, 'D:\\', { onCollision: 'skip' });
  assert.deepEqual(skipped.done.map((item) => item.name), ['Budget.xlsx']);
  assert.deepEqual(skipped.skipped, [{ source: `${DOCS}\\Lettre.txt`, name: 'Lettre.txt', reason: 'collision' }]);
  // « Conserver les deux » : la copie reçoit un nouveau nom.
  const kept = await operations.copy([`${DOCS}\\Lettre.txt`], 'D:\\', { onCollision: 'keep-both' });
  assert.deepEqual(kept.done, [{ source: `${DOCS}\\Lettre.txt`, name: 'Lettre - Copie.txt', path: 'D:\\Lettre - Copie.txt' }]);

  // Le fichier qui portait déjà ce nom n'a pas changé (999 octets ; l'original en fait 120).
  const entries = (await files.list('D:\\')).entries;
  assert.equal(entries.find((item) => item.name === 'Lettre.txt').size, 999);
  assert.equal(entries.find((item) => item.name === 'Lettre - Copie.txt').size, 120);
  assert.deepEqual(disk.overwritten, []);

  // « Remplacer » n'existe pas.
  for (const policy of ['replace', 'overwrite', 'force', '', 42, true]) {
    assert.equal(await codeOf(operations.copy(sources, 'D:\\', { onCollision: policy })), 'bad-arguments', String(policy));
  }
  assert.equal(await codeOf(operations.copy(sources, 'D:\\', { overwrite: true })), 'bad-arguments');
});

test('copier : un fichier apparu à destination après le contrôle n’est pas remplacé (copie exclusive)', async () => {
  // Juste avant la copie, un autre programme crée un fichier du même nom à destination.
  const wrap = (disk) =>
    new Proxy(disk.fs, {
      get(target, property) {
        if (property !== 'copyFile') return target[property];
        return (from, to, mode, callback) => {
          disk.mutate((drives) => {
            drives['D:\\'].tree.Sauvegardes['Budget.xlsx'] = file(555);
          });
          target.copyFile(from, to, mode, callback);
        };
      },
    });
  const { disk, files, operations } = pc({ wrap });
  const report = await operations.copy([`${DOCS}\\Budget.xlsx`], 'D:\\Sauvegardes');
  assert.deepEqual(report.done, []);
  assert.deepEqual(report.failed.map((item) => [item.name, item.code]), [['Budget.xlsx', 'collision']]);
  assert.equal((await files.list('D:\\Sauvegardes')).entries[0].size, 555, 'le fichier de l’autre programme est intact');
  assert.deepEqual(disk.overwritten, []);
});

// ---------------------------------------------------------------------------------
// Déplacer
// ---------------------------------------------------------------------------------

test('déplacer : un fichier et un dossier, sur le même lecteur', async () => {
  const { disk, files, operations } = pc();
  const report = await operations.move([`${DOCS}\\Lettre.txt`, `${DOCS}\\Projets`], `${DOCS}\\Archives`, CONFIRMED);
  assert.equal(report.status, 'done');
  assert.deepEqual(report.done, [
    { source: `${DOCS}\\Lettre.txt`, name: 'Lettre.txt', path: `${DOCS}\\Archives\\Lettre.txt` },
    { source: `${DOCS}\\Projets`, name: 'Projets', path: `${DOCS}\\Archives\\Projets` },
  ]);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Archives`), ['Lettre.txt', 'Projets']);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Archives\\Projets\\Été`), ['Vers Windows', 'photo.jpg']);
  const names = await namesIn(files, DOCS);
  assert.ok(!names.includes('Lettre.txt') && !names.includes('Projets'));
  // Un simple renommage par élément : rien n'est copié, rien ne passe par la Corbeille.
  assert.deepEqual(disk.writes().map(([name]) => name), ['rename', 'rename']);
  assert.deepEqual(disk.bin, []);
  assert.deepEqual(disk.overwritten, []);
});

test('déplacer exige une confirmation déclarée ; sans elle, rien ne bouge', async () => {
  const { disk, operations } = pc();
  const before = disk.snapshot();
  for (const options of [undefined, null, {}, { confirmed: false }, { onCollision: 'keep-both' }]) {
    assert.equal(await codeOf(operations.move([`${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`, options)), 'needs-confirmation');
  }
  for (const options of [{ confirmed: 'oui' }, { confirmed: 1 }, 'confirmed', [true]]) {
    assert.equal(await codeOf(operations.move([`${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`, options)), 'bad-arguments');
  }
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes(), []);
});

test('déplacer vers un autre lecteur : copie, puis original envoyé à la Corbeille — jamais supprimé', async () => {
  const { disk, files, operations } = pc();
  const report = await operations.move([`${DOCS}\\Projets`, `${DOCS}\\Budget.xlsx`], 'D:\\Sauvegardes', CONFIRMED);
  assert.deepEqual(report.done, [
    { source: `${DOCS}\\Projets`, name: 'Projets', path: 'D:\\Sauvegardes\\Projets', original: 'trashed' },
    { source: `${DOCS}\\Budget.xlsx`, name: 'Budget.xlsx', path: 'D:\\Sauvegardes\\Budget.xlsx', original: 'trashed' },
  ]);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(await namesIn(files, 'D:\\Sauvegardes'), ['Budget.xlsx', 'Projets']);
  assert.deepEqual(await namesIn(files, 'D:\\Sauvegardes\\Projets\\Été'), ['photo.jpg']);
  const names = await namesIn(files, DOCS);
  assert.ok(!names.includes('Projets') && !names.includes('Budget.xlsx'));
  // Les originaux sont dans la Corbeille, entiers.
  assert.deepEqual(disk.bin.map((item) => item.path), [`${DOCS}\\Projets`, `${DOCS}\\Budget.xlsx`]);
  assert.deepEqual(disk.overwritten, []);
});

test('déplacer vers un autre lecteur, Corbeille en échec : la copie existe et l’original reste à sa place', async () => {
  const { disk, files, operations } = pc({ trash: async () => Promise.reject(new Error('Operation was aborted')) });
  const report = await operations.move([`${DOCS}\\Budget.xlsx`], 'D:\\Sauvegardes', CONFIRMED);
  assert.deepEqual(report.done, []);
  assert.equal(report.failed.length, 1);
  assert.deepEqual([report.failed[0].code, report.failed[0].path], ['original-kept', 'D:\\Sauvegardes\\Budget.xlsx']);
  assert.match(report.failed[0].message, /l'original n'a pas pu être envoyé à la Corbeille : il est resté à sa place/);
  assert.ok((await namesIn(files, DOCS)).includes('Budget.xlsx'));
  assert.deepEqual(await namesIn(files, 'D:\\Sauvegardes'), ['Budget.xlsx']);
  assert.deepEqual(disk.bin, []);
});

test('déplacer : nom déjà pris — question, « ignorer », « conserver les deux » ; jamais de remplacement', async () => {
  const { disk, files, operations } = pc();
  const before = disk.snapshot();
  const asked = await operations.move([`${DOCS}\\Lettre.txt`, `${DOCS}\\Budget.xlsx`], 'D:\\', CONFIRMED);
  assert.deepEqual([asked.status, asked.collisions.map((item) => item.name)], ['collisions', ['Lettre.txt']]);
  assert.deepEqual(disk.snapshot(), before);

  const skipped = await operations.move([`${DOCS}\\Lettre.txt`], 'D:\\', { confirmed: true, onCollision: 'skip' });
  assert.deepEqual([skipped.done, skipped.skipped.map((item) => item.reason)], [[], ['collision']]);
  assert.deepEqual(disk.snapshot(), before);

  // Sur le même lecteur : le fichier déplacé reçoit un nouveau nom, l'autre n'est pas touché.
  await operations.copy([`${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`);
  const kept = await operations.move([`${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`, { confirmed: true, onCollision: 'keep-both' });
  assert.deepEqual(kept.done.map((item) => item.name), ['Lettre - Copie.txt']);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Archives`), ['Lettre - Copie.txt', 'Lettre.txt']);
  assert.deepEqual(disk.overwritten, []);
});

test('déplacer : un fichier apparu à destination entre le contrôle et le déplacement est détecté', async () => {
  // Le plan est établi, puis un fichier du même nom apparaît : le dernier contrôle, juste avant le renommage, le voit.
  let planned = 0;
  const wrap = (disk) =>
    new Proxy(disk.fs, {
      get(target, property) {
        if (property !== 'lstat') return target[property];
        return (location, options, callback) => {
          if (location === `${DOCS}\\Archives\\Lettre.txt`) {
            planned += 1;
            if (planned === 2) disk.mutate((drives) => (drives['C:\\'].tree.Users.Léo.Documents.Archives['Lettre.txt'] = file(777)));
          }
          target.lstat(location, options, callback);
        };
      },
    });
  const { disk, files, operations } = pc({ wrap });
  const report = await operations.move([`${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`, CONFIRMED);
  assert.deepEqual(report.failed.map((item) => item.code), ['collision']);
  assert.equal((await files.list(`${DOCS}\\Archives`)).entries[0].size, 777);
  assert.ok((await namesIn(files, DOCS)).includes('Lettre.txt'));
  assert.deepEqual(disk.overwritten, []);
});

test('déplacer dans le dossier où l’élément se trouve déjà : rien à faire', async () => {
  const { disk, operations } = pc();
  const report = await operations.move([`${DOCS}\\Lettre.txt`, `${DOCS}\\Projets`], DOCS, CONFIRMED);
  assert.deepEqual([report.done, report.skipped.map((item) => item.reason)], [[], ['same-location', 'same-location']]);
  assert.deepEqual(disk.writes(), []);
});

test('un dossier n’est jamais déplacé ni copié dans lui-même ou dans l’un de ses sous-dossiers', async () => {
  const { disk, operations } = pc();
  const before = disk.snapshot();
  const destinations = [
    `${DOCS}\\Projets`,
    `${DOCS}\\Projets\\Été`,
    `${DOCS}\\PROJETS\\été`, // même dossier, écrit autrement
    `${DOCS}\\Vers Projets`, // jonction qui mène au dossier lui-même
    `${DOCS}\\Vers Projets\\Été`,
  ];
  for (const destination of destinations) {
    assert.equal(await codeOf(operations.move([`${DOCS}\\Projets`], destination, CONFIRMED)), 'into-itself', destination);
    assert.equal(await codeOf(operations.copy([`${DOCS}\\Projets`], destination)), 'into-itself', destination);
    // Un seul élément fautif suffit à refuser toute la demande.
    assert.equal(await codeOf(operations.move([`${DOCS}\\Lettre.txt`, `${DOCS}\\Projets`], destination, CONFIRMED)), 'into-itself', destination);
  }
  // Un dossier et l'un des éléments qu'il contient, dans la même demande.
  assert.equal(await codeOf(operations.move([`${DOCS}\\Projets`, `${DOCS}\\Projets\\plan.pdf`], `${DOCS}\\Archives`, CONFIRMED)), 'invalid-selection');
  assert.equal(await codeOf(operations.trash([`${DOCS}\\Projets\\Été`, `${DOCS}\\Projets`], CONFIRMED)), 'invalid-selection');
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes(), []);
  assert.deepEqual(disk.bin, []);
});

// ---------------------------------------------------------------------------------
// Supprimer : la Corbeille, et rien d'autre
// ---------------------------------------------------------------------------------

test('supprimer : plusieurs éléments partent à la Corbeille (simulée) — aucune fonction du disque n’est employée', async () => {
  const { disk, files, operations } = pc();
  const report = await operations.trash([`${DOCS}\\Lettre.txt`, `${DOCS}\\Projets`, `${DOCS}\\Archives`, `${DOCS}\\Lettre.txt`], CONFIRMED);
  assert.deepEqual(report, {
    status: 'done',
    operation: 'trash',
    done: [
      { source: `${DOCS}\\Lettre.txt`, name: 'Lettre.txt' },
      { source: `${DOCS}\\Projets`, name: 'Projets' },
      { source: `${DOCS}\\Archives`, name: 'Archives' },
    ],
    skipped: [],
    failed: [],
    cancelled: false,
  });
  // Les éléments ont quitté leur dossier et se trouvent, entiers, dans la Corbeille.
  assert.deepEqual(disk.bin.map((item) => item.path), [`${DOCS}\\Lettre.txt`, `${DOCS}\\Projets`, `${DOCS}\\Archives`]);
  const names = await namesIn(files, DOCS);
  assert.ok(!names.includes('Lettre.txt') && !names.includes('Projets') && !names.includes('Archives'));
  assert.ok(names.includes('Budget.xlsx'));
  // Le service n'a rien modifié lui-même : ni création, ni renommage, ni copie.
  assert.deepEqual(disk.writes(), []);
});

test('supprimer exige une confirmation déclarée et une Corbeille ; sinon rien ne bouge', async () => {
  const { disk, operations } = pc();
  const before = disk.snapshot();
  for (const options of [undefined, null, {}, { confirmed: false }]) {
    assert.equal(await codeOf(operations.trash([`${DOCS}\\Lettre.txt`], options)), 'needs-confirmation');
  }
  for (const targets of [[], 'C:\\x', null, [42], [`${DOCS}\\Lettre.txt`, null], Array.from({ length: 1001 }, (_, index) => `${DOCS}\\${index}`)]) {
    assert.equal(await codeOf(operations.trash(targets, CONFIRMED)), 'bad-arguments');
  }
  assert.equal(await codeOf(operations.trash([`${DOCS}\\Lettre.txt`], { confirmed: true, permanent: true })), 'bad-arguments');
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.bin, []);

  // Sans Corbeille, aucune suppression n'est possible : il n'existe pas d'autre moyen.
  const without = pc({ trash: null });
  assert.equal(await codeOf(without.operations.trash([`${DOCS}\\Lettre.txt`], CONFIRMED)), 'trash-unavailable');
  assert.deepEqual(without.disk.snapshot(), before);
  assert.deepEqual(without.operations.status(), { busy: false, trash: false, open: true, deletion: 'recycle-bin-only', replace: 'never' });
});

test('Corbeille en échec : l’élément reste à sa place — aucune suppression de secours', async () => {
  const sent = [];
  const { disk, files, operations } = pc({
    trash: async (target) => {
      sent.push(target);
      if (target.endsWith('Budget.xlsx')) throw new Error('Operation was aborted'); // élément que la Corbeille ne peut pas recevoir
      if (target.endsWith('Lettre.txt')) return; // Windows annonce une réussite, mais l'élément n'a pas bougé
      await disk.recycle(target);
    },
  });
  const report = await operations.trash([`${DOCS}\\Budget.xlsx`, `${DOCS}\\Lettre.txt`, `${DOCS}\\Archives`], CONFIRMED);
  assert.deepEqual(report.done, [{ source: `${DOCS}\\Archives`, name: 'Archives' }]);
  assert.deepEqual(report.failed.map((item) => [item.name, item.code]), [['Budget.xlsx', 'trash-failed'], ['Lettre.txt', 'trash-failed']]);
  assert.match(report.failed[0].message, /n'a pas été supprimé et reste à sa place/);
  assert.match(report.failed[1].message, /toujours à sa place/);
  // Une seule tentative par élément, et les deux éléments refusés sont toujours là.
  assert.deepEqual(sent, [`${DOCS}\\Budget.xlsx`, `${DOCS}\\Lettre.txt`, `${DOCS}\\Archives`]);
  const names = await namesIn(files, DOCS);
  assert.ok(names.includes('Budget.xlsx') && names.includes('Lettre.txt') && !names.includes('Archives'));
  assert.deepEqual(disk.writes(), []);
  assert.deepEqual([...disk.touched].filter((name) => /rm|unlink|truncate|write/i.test(name)), []);
});

// ---------------------------------------------------------------------------------
// Emplacements préservés
// ---------------------------------------------------------------------------------

test('lecteurs, dossiers personnels et dossiers qui les contiennent : ni renommés, ni déplacés, ni copiés, ni supprimés', async () => {
  const { disk, operations } = pc();
  const before = disk.snapshot();
  const targets = ['C:\\', 'D:\\', 'c:/', DOCS, DESKTOP, `${PROFILE}\\Pictures`, 'c:\\users\\léo\\DOCUMENTS', `${DOCS}\\`, PROFILE, 'C:\\Users', 'C:\\Windows', 'C:\\Program Files'];
  for (const target of targets) {
    assert.equal(await codeOf(operations.rename(target, 'Autre')), 'protected', target);
    assert.equal(await codeOf(operations.move([target], 'D:\\Sauvegardes', CONFIRMED)), 'protected', target);
    assert.equal(await codeOf(operations.copy([target], 'D:\\Sauvegardes')), 'protected', target);
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), 'protected', target);
    // Dans une sélection de plusieurs éléments, un seul élément préservé fait refuser toute la demande.
    assert.equal(await codeOf(operations.trash([`${DOCS}\\Lettre.txt`, target], CONFIRMED)), 'protected', target);
  }
  // Windows ignore un point ou une espace en fin de nom : « Documents. » désignerait « Documents ».
  for (const alias of [`${DOCS}.`, `${DOCS} `, `${DOCS}...`, `${PROFILE}.\\Documents`]) {
    assert.equal(await codeOf(operations.trash([alias], CONFIRMED)), 'invalid-path', alias);
    assert.equal(await codeOf(operations.rename(alias, 'Autre')), 'invalid-path', alias);
  }
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes(), []);
  assert.deepEqual(disk.bin, []);
});

test('dossiers du système (Windows, programmes, données des applications) : rien n’y est créé, modifié, collé ni supprimé', async () => {
  const { disk, files, operations } = pc();
  const before = disk.snapshot();
  const folders = ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files\\Outil', 'C:\\ProgramData\\Partage', `${PROFILE}\\AppData`, `${PROFILE}\\AppData\\Roaming\\Evolve`, `${PROFILE}\\AppData\\Local\\Temp`, 'C:\\$Recycle.Bin'];
  for (const folder of folders) {
    assert.equal(await codeOf(operations.createFolder(folder, 'Nouveau dossier')), 'protected', folder);
    assert.equal(await codeOf(operations.copy([`${DOCS}\\Lettre.txt`], folder)), 'protected', folder);
    assert.equal(await codeOf(operations.move([`${DOCS}\\Lettre.txt`], folder, CONFIRMED)), 'protected', folder);
  }
  const items = ['C:\\Windows\\win.ini', 'C:\\Windows\\System32\\cmd.exe', 'C:\\Program Files\\Outil\\outil.exe', 'C:\\ProgramData\\Partage', `${PROFILE}\\AppData\\Roaming\\Evolve\\settings.json`, 'C:\\pagefile.sys', 'C:\\$Recycle.Bin'];
  for (const item of items) {
    assert.equal(await codeOf(operations.rename(item, 'autre.txt')), 'protected', item);
    assert.equal(await codeOf(operations.move([item], `${DOCS}\\Archives`, CONFIRMED)), 'protected', item);
    assert.equal(await codeOf(operations.trash([item], CONFIRMED)), 'protected', item);
  }
  // À travers une jonction placée dans Documents : c'est l'emplacement réel qui compte.
  assert.equal(await codeOf(operations.createFolder(`${DOCS}\\Vers Windows`, 'x')), 'protected');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Vers Windows\\win.ini`, 'x.ini')), 'protected');
  assert.equal(await codeOf(operations.trash([`${DOCS}\\Vers Windows\\System32\\cmd.exe`], CONFIRMED)), 'protected');
  assert.equal(await codeOf(operations.copy([`${DOCS}\\Lettre.txt`], `${DOCS}\\Vers Windows`)), 'protected');
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes(), []);
  assert.deepEqual(disk.bin, []);

  // Copier un fichier DEPUIS un dossier du système reste possible : il n'y est que lu.
  const report = await operations.copy(['C:\\Windows\\win.ini'], `${DOCS}\\Archives`);
  assert.deepEqual(report.done.map((item) => item.path), [`${DOCS}\\Archives\\win.ini`]);
  assert.deepEqual(await namesIn(files, 'C:\\Windows'), ['System32', 'win.ini']);
});

test('dossiers du système : une variable de Windows mal renseignée n’interdit ni n’autorise tout', async () => {
  const disk = createFakeFs({ platform: 'win32', drives: { 'C:\\': { tree: { Windows: {}, Données: { 'a.txt': file(1) }, Roaming: {} } } } });
  const files = createFilesService({ platform: 'win32', drives: ['C:\\'], fs: disk.fs, env: {} });
  // Variables absentes, relatives, réseau, ou désignant un lecteur entier.
  const env = { SystemRoot: 'C:\\', ProgramFiles: '\\\\serveur\\partage', ProgramData: 'relatif', APPDATA: 'C:\\Roaming', LOCALAPPDATA: 42 };
  const operations = createFileOperations({ guard: files.guard, fs: disk.fs, env, trash: disk.recycle });
  // Le lecteur n'est pas devenu intouchable…
  assert.equal((await operations.createFolder('C:\\Données', 'Nouveau')).path, 'C:\\Données\\Nouveau');
  // … le dossier désigné par APPDATA est préservé (son parent, le lecteur, ne l'est pas) …
  assert.equal(await codeOf(operations.createFolder('C:\\Roaming', 'x')), 'protected');
  // … et le dossier de Windows l'est par son nom, même sans variable utilisable.
  assert.equal(await codeOf(operations.createFolder('C:\\Windows', 'x')), 'protected');
  assert.equal(await codeOf(operations.trash(['C:\\Windows'], CONFIRMED)), 'protected');
});

test('les liens (liens symboliques, jonctions) ne sont ni renommés, ni copiés, ni déplacés, ni supprimés, ni ouverts', async () => {
  const { disk, operations, opened } = pc();
  const before = disk.snapshot();
  for (const target of [`${DOCS}\\Vers Windows`, `${DOCS}\\Vers Images`, `${DOCS}\\Vers le NAS`, `${DOCS}\\Projets\\Été\\Vers Windows`]) {
    assert.equal(await codeOf(operations.rename(target, 'Autre')), 'link-not-supported', target);
    assert.equal(await codeOf(operations.copy([target], `${DOCS}\\Archives`)), 'link-not-supported', target);
    assert.equal(await codeOf(operations.move([target], `${DOCS}\\Archives`, CONFIRMED)), 'link-not-supported', target);
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), 'link-not-supported', target);
    assert.equal(await codeOf(operations.open(target, CONFIRMED)), 'link-not-supported', target);
  }
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual([disk.writes(), disk.bin, opened], [[], [], []]);
});

// ---------------------------------------------------------------------------------
// Chemins interdits
// ---------------------------------------------------------------------------------

test('chemins interdits : relatifs, « .. », réseau, espaces de noms, périphériques, flux — aucune opération, aucun accès au disque', async () => {
  const { disk, operations, opened } = pc();
  await operations.status(); // (aucun effet)
  const before = disk.snapshot();
  const forbidden = [
    'Documents\\Lettre.txt', // relatif
    '..\\Lettre.txt',
    `${DOCS}\\..\\Desktop\\Notes.txt`, // traversée
    `${DOCS}\\Projets\\..\\..\\..\\..\\Windows\\win.ini`,
    `${DOCS}/../../../Windows/win.ini`,
    'C:..\\Lettre.txt',
    'C:Lettre.txt',
    '\\\\nas\\partage\\Documents\\secret.txt', // partage réseau
    '//nas/partage/Documents/secret.txt',
    '\\\\?\\C:\\Windows\\win.ini', // espaces de noms
    '\\\\.\\C:\\Windows\\win.ini',
    '\\\\.\\PhysicalDrive0',
    `${DOCS}\\NUL`, // périphériques
    `${DOCS}\\CON.txt`,
    `${DOCS}\\Lettre.txt:flux`, // flux secondaire
    `${DOCS}\\Lettre.txt::$DATA`,
    `${DOCS}\\Lettre\u0000.txt`,
    '',
    'C:',
  ];
  const calls = disk.calls.length;
  for (const target of forbidden) {
    assert.equal(await codeOf(operations.createFolder(target, 'x')), 'invalid-path', target);
    assert.equal(await codeOf(operations.rename(target, 'x.txt')), 'invalid-path', target);
    assert.equal(await codeOf(operations.copy([target], `${DOCS}\\Archives`)), 'invalid-path', target);
    assert.equal(await codeOf(operations.copy([`${DOCS}\\Lettre.txt`], target)), 'invalid-path', target);
    assert.equal(await codeOf(operations.move([target], `${DOCS}\\Archives`, CONFIRMED)), 'invalid-path', target);
    assert.equal(await codeOf(operations.move([`${DOCS}\\Lettre.txt`], target, CONFIRMED)), 'invalid-path', target);
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), 'invalid-path', target);
    assert.equal(await codeOf(operations.open(target, CONFIRMED)), 'invalid-path', target);
  }
  // Refusés sur leur seule forme : le disque n'a pas été consulté une seule fois.
  assert.equal(disk.calls.length, calls, 'aucun chemin refusé n’a atteint le disque');
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual([disk.writes(), disk.bin, opened], [[], [], []]);
});

test('emplacements non autorisés : lecteur réseau, et liens qui mènent hors des emplacements autorisés', async () => {
  const { disk, operations, opened } = pc();
  const before = disk.snapshot();
  // « Z: » mène à un partage réseau : ce n'est pas un emplacement autorisé.
  for (const target of ['Z:\\Documents\\secret.txt', 'Z:\\Documents', 'Z:\\']) {
    assert.equal(await codeOf(operations.rename(target, 'x')), target === 'Z:\\' ? 'protected' : 'outside-allowed', target);
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), target === 'Z:\\' ? 'protected' : 'outside-allowed', target);
    assert.equal(await codeOf(operations.copy([`${DOCS}\\Lettre.txt`], target)), 'outside-allowed', target);
    assert.equal(await codeOf(operations.move([`${DOCS}\\Lettre.txt`], target, CONFIRMED)), 'outside-allowed', target);
    assert.equal(await codeOf(operations.createFolder(target, 'x')), 'outside-allowed', target);
  }
  assert.equal(await codeOf(operations.open('Z:\\Documents\\secret.txt')), 'outside-allowed');
  assert.equal(await codeOf(operations.copy(['Z:\\Documents\\secret.txt'], `${DOCS}\\Archives`)), 'outside-allowed');

  // Une jonction placée dans Documents mène au partage réseau : tout ce qui passe par elle est refusé.
  const through = `${DOCS}\\Vers le NAS`;
  assert.equal(await codeOf(operations.createFolder(through, 'x')), 'leads-outside');
  assert.equal(await codeOf(operations.copy([`${DOCS}\\Lettre.txt`], through)), 'leads-outside');
  assert.equal(await codeOf(operations.move([`${DOCS}\\Lettre.txt`], through, CONFIRMED)), 'leads-outside');
  assert.equal(await codeOf(operations.rename(`${through}\\secret.txt`, 'x.txt')), 'leads-outside');
  assert.equal(await codeOf(operations.trash([`${through}\\secret.txt`], CONFIRMED)), 'leads-outside');
  assert.equal(await codeOf(operations.copy([`${through}\\secret.txt`], `${DOCS}\\Archives`)), 'leads-outside');
  assert.equal(await codeOf(operations.open(`${through}\\secret.txt`)), 'leads-outside');

  // Rien n'a changé, nulle part — ni sur le partage, ni sur les disques.
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual([disk.writes(), disk.bin, opened], [[], [], []]);
});

test('aucune opération ne modifie un emplacement non autorisé ou préservé : chaque écriture est située', async () => {
  const { disk, operations } = pc();
  const outside = () => [...disk.snapshot('\\\\nas\\partage\\'), ...disk.snapshot('Z:\\')];
  const untouchable = () => disk.snapshot().filter((line) => /^C:\\(?:Windows|Program Files|ProgramData|\$Recycle\.Bin|pagefile\.sys|Users\\Léo\\AppData)/.test(line));
  const before = [outside(), untouchable()];

  // Une session ordinaire, mêlée de demandes refusées.
  await operations.createFolder(DOCS, 'Factures');
  await operations.copy([`${DOCS}\\Projets`, `${DOCS}\\Lettre.txt`], `${DOCS}\\Factures`);
  await operations.move([`${DOCS}\\Budget.xlsx`], 'D:\\Sauvegardes', CONFIRMED);
  await operations.rename(`${DOCS}\\Lettre.txt`, 'Courrier.txt');
  await operations.trash([`${DOCS}\\Courrier.txt`], CONFIRMED);
  await operations.copy(['C:\\Windows\\win.ini'], DOCS);
  for (const attempt of [
    () => operations.createFolder('Z:\\Documents', 'x'),
    () => operations.copy([`${DOCS}\\Projets`], `${DOCS}\\Vers le NAS`),
    () => operations.move([`${DOCS}\\Projets`], 'C:\\Windows', CONFIRMED),
    () => operations.trash(['C:\\Windows\\win.ini'], CONFIRMED),
    () => operations.rename('C:\\Program Files\\Outil', 'x'),
  ]) await codeOf(attempt());

  assert.deepEqual([outside(), untouchable()], before);
  // Chaque écriture a eu lieu dans le profil de l'utilisateur ou sur le second disque — jamais ailleurs.
  const allowed = /^(?:C:\\Users\\Léo\\(?:Documents|Desktop|Pictures|Music|Downloads)|D:)\\/;
  for (const [name, from, to] of disk.writes()) {
    assert.match(name === 'mkdir' ? from : to, allowed, `${name} ${from} ${to ?? ''}`);
    // La source d'une copie peut être un dossier du système ; celle d'un renommage, jamais.
    if (name === 'rename') assert.match(from, allowed, `${name} ${from}`);
  }
  for (const item of disk.bin) assert.match(item.path, allowed);
  assert.deepEqual(disk.overwritten, []);
});

// ---------------------------------------------------------------------------------
// Erreurs du système
// ---------------------------------------------------------------------------------

test('erreurs du système : accès refusé, élément utilisé, disque plein — signalées en clair, sans dégât', async () => {
  const errors = {
    mkdir: { [`${DOCS}\\Interdit`]: 'EACCES', [`${DOCS}\\Protégé`]: 'EPERM', [`${DOCS}\\Lecture seule`]: 'EROFS' },
    rename: { [`${DOCS}\\Lettre.txt`]: 'EBUSY', [`${DOCS}\\Budget.xlsx`]: 'EPERM' },
    copyFile: { [`${DOCS}\\programme.exe`]: 'ENOSPC', [`${DESKTOP}\\Notes.txt`]: 'EIO' },
  };
  const { disk, operations } = pc({ errors });
  const before = disk.snapshot();
  assert.equal(await codeOf(operations.createFolder(DOCS, 'Interdit')), 'access-denied');
  assert.equal(await codeOf(operations.createFolder(DOCS, 'Protégé')), 'access-denied');
  assert.equal(await codeOf(operations.createFolder(DOCS, 'Lecture seule')), 'access-denied');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Lettre.txt`, 'x.txt')), 'in-use');
  assert.equal(await codeOf(operations.rename(`${DOCS}\\Budget.xlsx`, 'x.xlsx')), 'access-denied');

  // Plusieurs éléments : ceux qui échouent sont signalés un à un, les autres aboutissent.
  const moved = await operations.move([`${DOCS}\\Lettre.txt`, `${DOCS}\\Budget.xlsx`, `${DOCS}\\programme.exe`], `${DOCS}\\Archives`, CONFIRMED);
  assert.deepEqual(moved.failed.map((item) => [item.name, item.code]), [['Lettre.txt', 'in-use'], ['Budget.xlsx', 'access-denied']]);
  assert.deepEqual(moved.done.map((item) => item.name), ['programme.exe']);
  await operations.move([`${DOCS}\\Archives\\programme.exe`], DOCS, CONFIRMED);
  assert.deepEqual(disk.snapshot(), before);

  const copied = await operations.copy([`${DOCS}\\programme.exe`, `${DESKTOP}\\Notes.txt`, `${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`);
  assert.deepEqual(copied.failed.map((item) => [item.name, item.code]), [['programme.exe', 'no-space'], ['Notes.txt', 'failed']]);
  assert.deepEqual(copied.done.map((item) => item.name), ['Lettre.txt']);
  for (const item of [...moved.failed, ...copied.failed]) {
    assert.ok(item.message.length > 20 && !/E[A-Z]{3,}|errno|syscall/.test(item.message), item.message);
  }
  assert.deepEqual(disk.overwritten, []);
});

test('copie d’un dossier interrompue par une erreur : la copie partielle porte un nom qui le dit, l’original est intact', async () => {
  const errors = { copyFile: { [`${DOCS}\\Projets\\Été\\photo.jpg`]: 'EACCES' } };
  const { disk, files, operations } = pc({ errors });
  const report = await operations.copy([`${DOCS}\\Projets`, `${DOCS}\\Lettre.txt`], 'D:\\Sauvegardes');
  assert.deepEqual(report.failed, [
    {
      source: `${DOCS}\\Projets`,
      name: 'Projets',
      code: 'access-denied',
      message: report.failed[0].message,
      at: 'Été\\photo.jpg',
      partial: 'Projets (copie incomplète)',
    },
  ]);
  // L'élément suivant a été copié normalement.
  assert.deepEqual(report.done.map((item) => item.name), ['Lettre.txt']);
  // À destination : aucun dossier « Projets » qui passerait pour une copie complète.
  assert.deepEqual(await namesIn(files, 'D:\\Sauvegardes'), ['Lettre.txt', 'Projets (copie incomplète)']);
  assert.deepEqual(await namesIn(files, 'D:\\Sauvegardes\\Projets (copie incomplète)'), ['plan.pdf', 'Été']);
  assert.deepEqual(await namesIn(files, `${DOCS}\\Projets\\Été`), ['Vers Windows', 'photo.jpg']);
  assert.deepEqual(disk.bin, []);

  // Même situation lors d'un déplacement vers un autre lecteur : l'original n'est pas envoyé à la Corbeille.
  const moved = await operations.move([`${DOCS}\\Projets`], 'D:\\Films', CONFIRMED);
  assert.deepEqual(moved.failed.map((item) => [item.code, item.partial]), [['access-denied', 'Projets (copie incomplète)']]);
  assert.ok((await namesIn(files, DOCS)).includes('Projets'));
  assert.deepEqual(disk.bin, []);
});

// ---------------------------------------------------------------------------------
// Progression, annulation, une opération à la fois
// ---------------------------------------------------------------------------------

test('progression annoncée, annulation entre deux éléments, une seule opération à la fois', async () => {
  const { disk, files, operations } = pc({ limits: { progressMs: 0 } });
  const events = [];
  const unsubscribe = operations.on((event) => events.push(event));

  // Copie suivie : chaque élément copié est annoncé, puis la fin de l'opération.
  await operations.copy([`${DOCS}\\Projets`, `${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`, { operation: 'copie-1' });
  const running = events.filter((event) => event.state === 'running');
  assert.deepEqual(running.map((event) => [event.operation, event.kind, event.done, event.total]), [
    ['copie-1', 'copy', 1, 5],
    ['copie-1', 'copy', 2, 5],
    ['copie-1', 'copy', 3, 5],
    ['copie-1', 'copy', 4, 5],
    ['copie-1', 'copy', 5, 5],
  ]);
  assert.deepEqual(events.at(-1), { operation: 'copie-1', kind: 'copy', state: 'finished' });

  // Pendant une opération, toute autre est refusée.
  const long = operations.copy([`${DOCS}\\Projets`], 'D:\\Sauvegardes', { operation: 'copie-2' });
  assert.equal(await codeOf(operations.createFolder(DOCS, 'Pendant')), 'busy');
  assert.equal(await codeOf(operations.trash([`${DOCS}\\Lettre.txt`], CONFIRMED)), 'busy');
  assert.equal(operations.status().busy, true);
  // Annulation : seule l'opération désignée est concernée.
  assert.equal(operations.cancel('autre'), false);
  assert.equal(operations.cancel('copie-2'), true);
  const report = await long;
  assert.equal(report.cancelled, true);
  assert.deepEqual(report.done, []);
  assert.equal(report.skipped[0].reason, 'cancelled');
  assert.equal(operations.status().busy, false);
  assert.equal(operations.cancel('copie-2'), false);
  // Ce qui avait été copié avant l'arrêt est signalé comme incomplet — jamais sous le nom définitif.
  const left = await namesIn(files, 'D:\\Sauvegardes');
  assert.ok(!left.includes('Projets'), left.join(', '));
  if (report.skipped[0].partial) assert.deepEqual(left, [report.skipped[0].partial]);

  unsubscribe();
  const count = events.length;
  await operations.createFolder(DOCS, 'Après');
  assert.equal(events.length, count, 'abonné retiré');
  // Identifiants d'opération : courts et simples.
  for (const operation of ['', 'a b', 'x'.repeat(65), '../x', 42, null]) {
    assert.equal(await codeOf(operations.copy([`${DOCS}\\Lettre.txt`], `${DOCS}\\Archives`, { operation })), 'bad-arguments', String(operation));
  }
  assert.deepEqual(disk.overwritten, []);
});

test('annuler avant la copie : le décompte des éléments s’arrête aussitôt, rien n’est parcouru ni copié', async () => {
  const { disk, operations } = pc({ limits: { progressMs: 0 } });
  const events = [];
  operations.on((event) => events.push(event));
  const before = disk.calls.length;

  const pending = operations.copy([`${DOCS}\\Projets`, `${DOCS}\\Lettre.txt`], 'D:\\Sauvegardes', { operation: 'copie' });
  assert.equal(operations.cancel('copie'), true);
  const report = await pending;

  assert.equal(report.cancelled, true);
  assert.deepEqual(report.done, []);
  assert.deepEqual(report.skipped.map((entry) => [entry.name, entry.reason]), [['Projets', 'cancelled'], ['Lettre.txt', 'cancelled']]);
  // Le dossier n'a pas été parcouru pour être compté : ni lui, ni ses sous-dossiers n'ont été ouverts.
  const read = disk.calls.slice(before).filter(([name]) => name === 'opendir').map(([, target]) => target);
  assert.deepEqual(read, []);
  assert.deepEqual(disk.writes(), []);
  assert.deepEqual(events, [{ operation: 'copie', kind: 'copy', state: 'finished' }]);
});

// ---------------------------------------------------------------------------------
// Ouvrir
// ---------------------------------------------------------------------------------

test('ouvrir : le fichier est confié à Windows par son chemin réel — rien n’est lu ni exécuté ici', async () => {
  const { disk, operations, opened } = pc();
  const before = disk.snapshot();
  assert.deepEqual(await operations.open(`${DOCS}\\Lettre.txt`), { opened: true, path: `${DOCS}\\Lettre.txt`, name: 'Lettre.txt' });
  // Chemin écrit autrement, ou passant par une jonction : c'est l'emplacement réel qui est transmis.
  await operations.open('c:/users/léo/documents/BUDGET.XLSX');
  await operations.open(`${DOCS}\\Vers Images\\fond.png`);
  await operations.open('C:\\Windows\\win.ini');
  assert.deepEqual(opened, [`${DOCS}\\Lettre.txt`, `${DOCS}\\Budget.xlsx`, `${PROFILE}\\Pictures\\fond.png`, 'C:\\Windows\\win.ini']);
  assert.deepEqual(disk.snapshot(), before);
  assert.deepEqual(disk.writes(), []);
  // Le contenu des fichiers n'est jamais lu : seules les trois fonctions de contrôle ont servi.
  assert.deepEqual([...new Set(disk.calls.map(([name]) => name))].sort(), ['lstat', 'realpath', 'statfs']);
});

test('ouvrir : un programme, un script ou un raccourci exige une confirmation explicite', async () => {
  const { operations, opened } = pc();
  for (const target of [`${DOCS}\\programme.exe`, `${DESKTOP}\\Jeu.lnk`, `${PROFILE}\\Downloads\\setup.msi`, 'C:\\Windows\\System32\\cmd.exe']) {
    assert.equal(await codeOf(operations.open(target)), 'needs-confirmation', target);
    assert.equal(await codeOf(operations.open(target, {})), 'needs-confirmation', target);
    assert.equal(await codeOf(operations.open(target, { confirmed: false })), 'needs-confirmation', target);
    assert.equal(await codeOf(operations.open(target, { confirmed: 'oui' })), 'bad-arguments', target);
  }
  assert.deepEqual(opened, []);
  assert.equal((await operations.open(`${DOCS}\\programme.exe`, CONFIRMED)).opened, true);
  assert.deepEqual(opened, [`${DOCS}\\programme.exe`]);
  // Les types que Windows exécute à l'ouverture sont tous concernés, quelle que soit la casse.
  for (const ext of ['exe', 'com', 'scr', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'hta', 'jar', 'lnk', 'url', 'reg', 'cpl', 'msc', 'pif', 'docm', 'xlsm', 'iso']) assert.ok(RUNS_CODE.has(ext), ext);
  for (const ext of ['txt', 'pdf', 'jpg', 'png', 'docx', 'xlsx', 'mp3', 'mp4', 'zip', 'csv', 'json']) assert.ok(!RUNS_CODE.has(ext), ext);
});

test('ouvrir : sûr par défaut — sans confirmation, seuls les types connus pour n’être qu’un contenu sont confiés à Windows', async () => {
  // Les deux listes : aucun type commun, des extensions en minuscules et sans point.
  assert.deepEqual([...OPENS_AS_CONTENT].filter((ext) => RUNS_CODE.has(ext)), []);
  for (const ext of [...OPENS_AS_CONTENT, ...RUNS_CODE]) assert.match(ext, /^[a-z0-9-]+$/, ext);
  for (const ext of ['txt', 'pdf', 'jpg', 'png', 'docx', 'xlsx', 'mp3', 'mp4', 'zip', 'csv', 'json', 'html']) assert.ok(OPENS_AS_CONTENT.has(ext), ext);
  for (const ext of ['', 'exe', 'bat', 'cmd', 'lnk', 'js', 'py', 'docm', 'xlsm', 'xll', 'msu', 'theme', 'dll', 'bin', 'dat']) assert.ok(!OPENS_AS_CONTENT.has(ext), ext);

  // Ouverts directement : un contenu, quelle que soit la casse de l'extension ; c'est la dernière extension qui compte.
  const direct = ['archive.tar.gz', 'Photo.JPG', 'notes.TXT', 'feuille.xlsx', '.txt', 'page.html', 'programme.exe.pdf'];
  // Programmes, scripts, raccourcis — y compris un fichier nommé « .bat » : pour Windows, c'est un script.
  const code = ['.bat', '.cmd', '.exe', '.lnk', 'facture.pdf.exe', 'script.PS1', 'macro.xlsm', 'Jeu.Lnk'];
  // Types que la liste ne connaît pas, et fichiers sans extension : confirmation aussi.
  const unknown = ['SANS EXTENSION', 'données.xyz', '.gitignore', 'mise à jour.msu', 'module.xll', 'thème.theme', 'bibliothèque.dll', 'sauvegarde.bak'];
  const names = [...direct, ...code, ...unknown];
  const disk = createFakeFs({
    platform: 'win32',
    drives: { 'C:\\': { tree: { Users: { Léo: { Documents: Object.fromEntries(names.map((name) => [name, file(10)])) } } } } },
  });
  const files = createFilesService({ platform: 'win32', places: { documents: DOCS }, drives: 'auto', fs: disk.fs, env: ENV });
  const opened = [];
  const operations = createFileOperations({ guard: files.guard, fs: disk.fs, env: ENV, trash: disk.recycle, openPath: async (target) => (opened.push(target), '') });
  const refusalOf = (name, options) => operations.open(`${DOCS}\\${name}`, options).then(() => null, (error) => error);

  for (const name of direct) assert.equal((await operations.open(`${DOCS}\\${name}`)).opened, true, name);
  assert.deepEqual(opened, direct.map((name) => `${DOCS}\\${name}`));

  for (const name of code) {
    for (const options of [undefined, {}, { confirmed: false }]) {
      const refusal = await refusalOf(name, options);
      assert.equal(refusal?.code, 'needs-confirmation', name);
      assert.match(refusal.message, /programme, un script ou un raccourci.*exécute du code/, name);
    }
  }
  for (const name of unknown) {
    for (const options of [undefined, {}, { confirmed: false }]) {
      const refusal = await refusalOf(name, options);
      assert.equal(refusal?.code, 'needs-confirmation', name);
      assert.match(refusal.message, /ne connaît pas ce type de fichier.*peut exécuter du code/, name);
    }
  }
  assert.equal(opened.length, direct.length, 'rien d’autre n’a été confié à Windows');

  // Confirmés, ils sont ouverts.
  for (const name of [...code, ...unknown]) assert.equal((await operations.open(`${DOCS}\\${name}`, CONFIRMED)).opened, true, name);
  assert.deepEqual(opened.slice(direct.length), [...code, ...unknown].map((name) => `${DOCS}\\${name}`));
  assert.deepEqual(disk.writes(), []);
});

test('ouvrir : ni dossier, ni élément absent ; un échec de Windows est signalé', async () => {
  const failing = pc({ openPath: async () => 'Failed to open path' });
  assert.equal(await codeOf(failing.operations.open(`${DOCS}\\Lettre.txt`)), 'open-failed');
  const throwing = pc({ openPath: async () => Promise.reject(new Error('panne')) });
  assert.equal(await codeOf(throwing.operations.open(`${DOCS}\\Lettre.txt`)), 'open-failed');

  const { operations, opened } = pc();
  assert.equal(await codeOf(operations.open(`${DOCS}\\Projets`)), 'not-a-file');
  assert.equal(await codeOf(operations.open(DOCS)), 'protected');
  assert.equal(await codeOf(operations.open('C:\\')), 'protected');
  assert.equal(await codeOf(operations.open(`${DOCS}\\Absent.txt`)), 'not-found');
  for (const value of [null, 42, {}, ['x'], undefined]) assert.equal(await codeOf(operations.open(value)), 'bad-arguments');
  assert.equal(await codeOf(operations.open(`${DOCS}\\Lettre.txt`, { verb: 'runas' })), 'bad-arguments');
  assert.deepEqual(opened, []);
});
