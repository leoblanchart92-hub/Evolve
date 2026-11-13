/**
 * Tests du déplacement sans remplacement (src/main/atomic-move.js) et du module
 * natif qu'il charge (native/evolve_fs.c, compilé par « npm run build:native »).
 *
 * Le module natif est éprouvé pour de bon, sur le disque de la machine qui
 * exécute les tests — NTFS et MoveFileExW sur la machine de compilation
 * Windows : un nom déjà pris est refusé par le système, et rien ne change.
 * La traduction des codes d'erreur de Windows et la forme des chemins sont
 * éprouvées avec un faux module, sur n'importe quelle machine.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadNativeMove, readText, stripComments } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { loadAtomicMove, createAtomicMove, ADDON_FILE, WINDOWS_ERRORS } = require('../src/main/atomic-move.js');

/** Le vrai module natif, chargé comme l'application le charge. */
const move = loadNativeMove();

const bases = [];
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true });
});

/** Dossier d'essai vide (chemin réel). */
function workDir() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'evolve-move-')));
  bases.push(base);
  return base;
}

/** Contenu d'un dossier : une ligne par élément ; les liens ne sont pas suivis. */
function listing(folder) {
  const lines = [];
  (function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const info = fs.lstatSync(full);
      const relative = path.relative(folder, full);
      if (info.isSymbolicLink()) lines.push(`${relative} -> lien`);
      else if (info.isDirectory()) {
        lines.push(`${relative}${path.sep}`);
        walk(full);
      } else lines.push(`${relative} = ${fs.readFileSync(full, 'utf8')}`);
    }
  })(folder);
  return lines;
}

/** Erreur par laquelle `promise` doit échouer. */
async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('la demande aurait dû échouer');
}

const makeFile = (location, content) => fs.writeFileSync(location, content);
const makeFolder = (location, content) => {
  fs.mkdirSync(location);
  fs.writeFileSync(path.join(location, 'contenu.txt'), content);
};

test('module natif : il est compilé, à l’endroit où l’application le cherche, et n’exporte qu’une fonction', () => {
  assert.equal(ADDON_FILE, path.resolve(import.meta.dirname, '..', 'native', 'build', 'Release', 'evolve_fs.node'));
  assert.ok(fs.statSync(ADDON_FILE).isFile());
  const binding = require(ADDON_FILE);
  assert.deepEqual(Object.keys(binding), ['moveNoReplace']);
  assert.equal(typeof binding.moveNoReplace, 'function');
});

test('module natif : vers un nom libre, l’élément est déplacé — fichier, dossier, noms accentués, autre dossier', async () => {
  const base = workDir();
  const at = (...names) => path.join(base, ...names);
  makeFile(at('Lettre à Zoé.txt'), 'lettre');
  makeFolder(at('Photos d’été'), 'photos');
  fs.mkdirSync(at('Rangé'));

  assert.equal(await move(at('Lettre à Zoé.txt'), at('Courrier d’août.txt')), undefined);
  await move(at('Photos d’été'), at('Rangé', 'Photos 2026'));
  await move(at('Courrier d’août.txt'), at('Rangé', 'Courrier.txt'));
  assert.deepEqual(listing(base), [`Rangé${path.sep}`, path.join('Rangé', 'Courrier.txt') + ' = lettre', `${path.join('Rangé', 'Photos 2026')}${path.sep}`, `${path.join('Rangé', 'Photos 2026', 'contenu.txt')} = photos`]);
});

test('module natif : vers un nom déjà pris, le système refuse (« EEXIST ») et rien ne change — quel que soit l’occupant', async () => {
  const occupants = [
    ['un fichier', (location) => makeFile(location, 'occupant')],
    ['un dossier vide', (location) => fs.mkdirSync(location)],
    ['un dossier non vide', (location) => makeFolder(location, 'occupant')],
    [
      'un lien',
      (location, base) => {
        fs.mkdirSync(path.join(base, 'cible'));
        // Jonction sous Windows (aucun droit particulier n'est nécessaire), lien symbolique ailleurs.
        fs.symlinkSync(path.join(base, 'cible'), location, 'junction');
      },
    ],
    // Un lien dont la cible n'existe pas occupe le nom, lui aussi.
    ['un lien sans cible', (location, base) => fs.symlinkSync(path.join(base, 'absent'), location, 'junction')],
  ];
  for (const [kind, make] of [['un fichier', makeFile], ['un dossier', makeFolder]]) {
    for (const [occupant, occupy] of occupants) {
      const label = `${kind} vers le nom d'${occupant}`;
      const base = workDir();
      occupy(path.join(base, 'occupant'), base);
      make(path.join(base, 'élément'), 'élément à déplacer');
      const before = listing(base);

      const error = await failureOf(move(path.join(base, 'élément'), path.join(base, 'occupant')));
      assert.equal(error.code, 'EEXIST', `${label} : ${error.message}`);
      assert.deepEqual(listing(base), before, `${label} : rien ne doit avoir changé`);
      // Une erreur de la même forme que celles du module de fichiers de Node.
      assert.ok(error instanceof Error && Number.isInteger(error.errno) && error.errno > 0, label);
      assert.deepEqual([error.syscall, error.path, error.dest], ['rename', path.join(base, 'élément'), path.join(base, 'occupant')], label);
      assert.match(error.message, /^EEXIST: déplacement sans remplacement impossible, /);
    }
  }
});

test('module natif : un élément déplacé sur lui-même n’est ni remplacé ni perdu ; changer la seule casse de son nom est admis', async () => {
  const base = workDir();
  const at = (...names) => path.join(base, ...names);
  makeFile(at('Budget.xlsx'), 'budget');
  makeFolder(at('Projets'), 'projets');

  // Vers son propre nom : selon le système, la demande est refusée ou sans effet. Dans les deux cas, rien ne change.
  for (const name of ['Budget.xlsx', 'Projets']) {
    await move(at(name), at(name)).catch((error) => assert.equal(error.code, 'EEXIST', error.message));
  }
  assert.deepEqual(listing(base), ['Budget.xlsx = budget', `Projets${path.sep}`, `${path.join('Projets', 'contenu.txt')} = projets`]);

  await move(at('Budget.xlsx'), at('BUDGET.xlsx'));
  await move(at('Projets'), at('PROJETS'));
  assert.deepEqual(fs.readdirSync(base).sort(), ['BUDGET.xlsx', 'PROJETS']);
  assert.deepEqual(listing(base), ['BUDGET.xlsx = budget', `PROJETS${path.sep}`, `${path.join('PROJETS', 'contenu.txt')} = projets`]);
});

test('module natif : élément absent, dossier d’arrivée absent, dossier déplacé dans lui-même — refusés, rien ne change', async () => {
  const base = workDir();
  const at = (...names) => path.join(base, ...names);
  makeFile(at('Lettre.txt'), 'lettre');
  makeFolder(at('Projets'), 'projets');
  const before = listing(base);

  assert.equal((await failureOf(move(at('Absent.txt'), at('Nouveau.txt')))).code, 'ENOENT');
  assert.equal((await failureOf(move(at('Lettre.txt'), at('Dossier absent', 'Lettre.txt')))).code, 'ENOENT');
  // Le code dépend du système (« EINVAL » sous Linux, un refus d'accès ou de partage sous Windows) : seul compte le refus.
  const inside = await failureOf(move(at('Projets'), at('Projets', 'Projets')));
  assert.equal(typeof inside.code, 'string', inside.message);
  assert.deepEqual(listing(base), before);
});

test('module natif : seuls des chemins complets sont admis ; les autres sont refusés avant toute demande au système', async () => {
  const base = workDir();
  makeFile(path.join(base, 'Lettre.txt'), 'lettre');
  const before = listing(base);
  const here = process.cwd();
  // Même depuis le dossier d'essai, un chemin relatif n'est pas suivi.
  process.chdir(base);
  try {
    for (const [from, to] of [
      ['Lettre.txt', path.join(base, 'Autre.txt')],
      [path.join(base, 'Lettre.txt'), 'Autre.txt'],
      ['', path.join(base, 'Autre.txt')],
      [path.join(base, 'Lettre.txt'), ''],
      [`${path.join(base, 'Lettre.txt')}\0`, path.join(base, 'Autre.txt')],
      [path.join(base, 'Lettre.txt'), `${path.join(base, 'Autre.txt')}\0.txt`],
      [null, path.join(base, 'Autre.txt')],
      [path.join(base, 'Lettre.txt'), undefined],
      [42, {}],
      [[path.join(base, 'Lettre.txt')], path.join(base, 'Autre.txt')],
    ]) {
      const error = await failureOf(move(from, to));
      assert.equal(error.code, 'EINVAL', `${String(from)} → ${String(to)}`);
    }
  } finally {
    process.chdir(here);
  }
  assert.deepEqual(listing(base), before);
});

test('module natif : appelé directement, il refuse tout argument qui n’est pas un texte non vide, sans rien demander au système', () => {
  const binding = require(ADDON_FILE);
  const valid = path.join(workDir(), 'élément');
  for (const args of [[], [valid], [valid, ''], ['', valid], [valid, null], [undefined, valid], [valid, 42], [{}, valid], [valid, `${valid}\0x`], [`a\0b`, valid]]) {
    assert.throws(() => binding.moveNoReplace(...args), TypeError, JSON.stringify(args));
  }
  // Une demande valide renvoie une promesse : le système est sollicité hors du fil principal.
  const pending = binding.moveNoReplace(valid, `${valid} 2`);
  assert.ok(pending instanceof Promise);
  return pending.then((code) => assert.ok(Number.isInteger(code) && code > 0, "élément absent : un code d'erreur du système, rien n'a été déplacé"));
});

// ---------------------------------------------------------------------------------
// Sous Windows : forme des chemins et traduction des codes d'erreur (faux module)
// ---------------------------------------------------------------------------------

/** Faux module natif : note les demandes et répond le code prévu. */
function fakeBinding(code = 0) {
  const calls = [];
  return { calls, binding: { moveNoReplace: async (from, to) => (calls.push([from, to]), typeof code === 'function' ? code(from, to) : code) } };
}

test('Windows : les chemins sont remis au système sous la forme « \\\\?\\C:\\… », qui admet les chemins longs et ne réinterprète aucun nom', async () => {
  const { calls, binding } = fakeBinding();
  const windowsMove = createAtomicMove(binding, { platform: 'win32' });
  const long = `C:\\Users\\Léo\\Documents\\${'a'.repeat(250)}\\Lettre.txt`;
  await windowsMove('C:\\Users\\Léo\\Documents\\Lettre à Zoé.txt', 'D:\\Sauvegardes\\Lettre à Zoé.txt');
  await windowsMove(long, 'c:\\Users\\Léo\\Documents\\court.txt');
  assert.deepEqual(calls, [
    ['\\\\?\\C:\\Users\\Léo\\Documents\\Lettre à Zoé.txt', '\\\\?\\D:\\Sauvegardes\\Lettre à Zoé.txt'],
    [`\\\\?\\${long}`, '\\\\?\\c:\\Users\\Léo\\Documents\\court.txt'],
  ]);
});

test('Windows : seul un chemin complet commençant par une lettre de lecteur est admis', async () => {
  const { calls, binding } = fakeBinding();
  const windowsMove = createAtomicMove(binding, { platform: 'win32' });
  const valid = 'C:\\Users\\Léo\\Documents\\Lettre.txt';
  const refusedPaths = [
    'Lettre.txt', // relatif
    'Documents\\Lettre.txt',
    'C:Lettre.txt', // relatif au dossier courant du lecteur
    'C:',
    '\\Users\\Léo\\Lettre.txt', // sans lecteur
    'C:/Users/Léo/Lettre.txt', // barres obliques : le système ne les convertirait pas
    '\\\\nas\\partage\\Lettre.txt', // réseau
    '\\\\?\\C:\\Users\\Léo\\Lettre.txt', // espace de noms
    '\\\\.\\C:\\Users\\Léo\\Lettre.txt',
    '/home/leo/Lettre.txt',
    '',
    'C:\\Users\\Léo\\Lettre.txt\0.exe',
  ];
  for (const location of refusedPaths) {
    assert.equal((await failureOf(windowsMove(location, valid))).code, 'EINVAL', `origine ${JSON.stringify(location)}`);
    assert.equal((await failureOf(windowsMove(valid, location))).code, 'EINVAL', `arrivée ${JSON.stringify(location)}`);
  }
  assert.deepEqual(calls, [], "aucune de ces demandes n'a atteint le système");
});

test('Windows : les codes d’erreur du système sont traduits — nom déjà pris, autre lecteur, élément utilisé, accès refusé', async () => {
  const expected = {
    183: 'EEXIST', // ERROR_ALREADY_EXISTS
    80: 'EEXIST', // ERROR_FILE_EXISTS
    17: 'EXDEV', // ERROR_NOT_SAME_DEVICE
    2: 'ENOENT',
    3: 'ENOENT',
    5: 'EPERM',
    32: 'EBUSY',
    33: 'EBUSY',
    112: 'ENOSPC',
    19: 'EROFS',
    206: 'ENAMETOOLONG',
    145: 'ENOTEMPTY',
    87: 'EINVAL',
    // Code inconnu, ou réponse inattendue du module : jamais pris pour une réussite.
    999: 'UNKNOWN',
    4294967295: 'UNKNOWN',
    [-1]: 'UNKNOWN',
  };
  for (const [number, code] of Object.entries(expected)) {
    const { binding } = fakeBinding(Number(number));
    const error = await failureOf(createAtomicMove(binding, { platform: 'win32' })('C:\\a.txt', 'C:\\b.txt'));
    assert.deepEqual([error.code, error.errno, error.path, error.dest], [code, Number(number), 'C:\\a.txt', 'C:\\b.txt'], `code ${number}`);
  }
  for (const answer of [undefined, null, '0', true, {}, NaN]) {
    const { binding } = fakeBinding(() => answer);
    assert.equal((await failureOf(createAtomicMove(binding, { platform: 'win32' })('C:\\a.txt', 'C:\\b.txt'))).code, 'UNKNOWN', `réponse ${String(answer)}`);
  }
  // Les deux codes de Windows pour « ce nom existe déjà » — et eux seuls — donnent « EEXIST ».
  assert.deepEqual(Object.entries(WINDOWS_ERRORS).filter(([, code]) => code === 'EEXIST').map(([number]) => Number(number)), [80, 183]);
  assert.deepEqual(Object.entries(WINDOWS_ERRORS).filter(([, code]) => code === 'EXDEV').map(([number]) => Number(number)), [17]);
  assert.ok(Object.isFrozen(WINDOWS_ERRORS));
});

// Hors de Windows, les codes d'erreur sont ceux du système qui exécute les tests : Node ne sait les nommer que chez lui.
test('autres systèmes : le code d’erreur du système est traduit par Node ; un chemin relatif est refusé', { skip: process.platform === 'win32' ? 'codes propres aux autres systèmes' : false }, async () => {
  const { calls, binding } = fakeBinding((from) => (from.endsWith('pris') ? 17 : from.endsWith('ailleurs') ? 18 : from.endsWith('inconnu') ? 987654 : 0));
  const posixMove = createAtomicMove(binding, { platform: 'linux' });
  await posixMove('/home/léo/libre', '/home/léo/nouveau');
  assert.equal((await failureOf(posixMove('/home/léo/pris', '/home/léo/b'))).code, 'EEXIST');
  assert.equal((await failureOf(posixMove('/home/léo/ailleurs', '/mnt/b'))).code, 'EXDEV');
  assert.equal((await failureOf(posixMove('/home/léo/inconnu', '/home/léo/b'))).code, 'UNKNOWN');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], ['/home/léo/libre', '/home/léo/nouveau'], 'chemins remis tels quels');
  assert.equal((await failureOf(posixMove('léo/libre', '/home/léo/b'))).code, 'EINVAL');
  assert.equal((await failureOf(posixMove('C:\\Users\\Léo\\a.txt', '/home/léo/b'))).code, 'EINVAL');
  assert.equal(calls.length, 4);
});

// ---------------------------------------------------------------------------------
// Chargement : sans le module natif, aucun repli
// ---------------------------------------------------------------------------------

test('chargement : module introuvable ou inutilisable — une erreur claire, et aucune autre façon de déplacer', () => {
  const absent = path.join(workDir(), 'absent.node');
  assert.throws(() => loadAtomicMove({ file: absent }), (error) => error.message.startsWith('Déplacement sans remplacement : module natif introuvable ou inutilisable (') && error.message.includes(absent));
  // Un fichier qui n'est pas un module natif.
  const broken = path.join(workDir(), 'faux.node');
  fs.writeFileSync(broken, 'ceci n’est pas un module natif');
  assert.throws(() => loadAtomicMove({ file: broken }), /module natif introuvable ou inutilisable/);
  // Un module qui n'offre pas la fonction attendue.
  for (const binding of [{}, { moveNoReplace: 'non' }, { rename: () => {} }, null, undefined]) {
    assert.throws(() => loadAtomicMove({ load: () => binding }), TypeError);
    assert.throws(() => createAtomicMove(binding), /fonction « moveNoReplace » absente/);
  }
  // Par défaut : le module compilé, à l'endroit prévu.
  const seen = [];
  const loaded = loadAtomicMove({ load: (file) => (seen.push(file), { moveNoReplace: async () => 0 }) });
  assert.deepEqual(seen, [ADDON_FILE]);
  assert.equal(typeof loaded, 'function');
});

test('aucun repli vers une fonction qui remplace : ni le chargeur ni le module natif ne connaissent d’autre déplacement', () => {
  // Le chargeur n'emploie pas le module de fichiers de Node : il ne peut donc pas renommer par lui.
  const loader = stripComments(readText('src/main/atomic-move.js'));
  assert.doesNotMatch(loader, /require\(\s*'(?:node:)?(?:fs|original-fs)(?:\/promises)?'\s*\)|\brename(?:Sync)?\s*\(|\bfs\b/);
  assert.deepEqual([...loader.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]), ['node:path', 'node:util']);

  // Le module natif : un seul appel au système par plate-forme, et jamais l'option de remplacement.
  const source = readText('native/evolve_fs.c').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual([...source.matchAll(/\bMoveFile\w*\s*\(/g)].map((match) => match[0].replace(/\s*\($/, '')), ['MoveFileExW']);
  assert.match(source, /MoveFileExW\(request->from, request->to, 0\)/, 'aucune option : ni remplacement, ni copie');
  assert.doesNotMatch(source, /MOVEFILE_\w+|ReplaceFile|CopyFile|DeleteFile|RemoveDirectory|SetFileInformationByHandle|\bunlink\b|\bremove\s*\(|\brename\s*\(|\brenameat\s*\(/);
  assert.deepEqual([...source.matchAll(/\bSYS_\w+/g)].map((match) => match[0]), ['SYS_renameat2']);
  assert.match(source, /syscall\(SYS_renameat2, AT_FDCWD, request->from, AT_FDCWD, request->to, RENAME_NOREPLACE\)/);
  assert.match(source, /#define RENAME_NOREPLACE \(1 << 0\)/);
  // Une seule fonction est exportée.
  assert.deepEqual([...source.matchAll(/napi_create_function\(env, "(\w+)"/g)].map((match) => match[1]), ['moveNoReplace']);
});
