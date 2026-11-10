/** Options de la ligne de commande de l'application. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { parseArgs, SELF_TEST_FLAG, STATUS_FILE_FLAG } = require('../src/main/args.js');

const EXE = 'C:\\Temp\\Evolve.exe';

test('sans option : plein écran, pas d’auto-test', () => {
  assert.deepEqual(parseArgs([EXE]), { windowed: false, devtools: false, selfTest: false, selfTestDir: null, statusFile: null });
});

test('--windowed et --devtools', () => {
  assert.equal(parseArgs([EXE, '--windowed']).windowed, true);
  assert.equal(parseArgs([EXE, '--devtools']).devtools, true);
  assert.deepEqual(parseArgs([EXE, '--devtools', '--windowed']), {
    windowed: true,
    devtools: true,
    selfTest: false,
    selfTestDir: null,
    statusFile: null,
  });
});

test('--self-test sans dossier', () => {
  assert.equal(SELF_TEST_FLAG, '--self-test');
  assert.deepEqual(parseArgs([EXE, '--self-test']), { windowed: false, devtools: false, selfTest: true, selfTestDir: null, statusFile: null });
  assert.deepEqual(parseArgs([EXE, '--self-test=']), { windowed: false, devtools: false, selfTest: true, selfTestDir: null, statusFile: null });
});

test('--self-test=DOSSIER, chemins avec espaces ou signe égal', () => {
  assert.equal(parseArgs([EXE, '--self-test=D:\\a\\_temp\\out']).selfTestDir, 'D:\\a\\_temp\\out');
  assert.equal(parseArgs([EXE, '--self-test=C:\\Mes documents\\test']).selfTestDir, 'C:\\Mes documents\\test');
  assert.equal(parseArgs([EXE, '--self-test=/tmp/a=b']).selfTestDir, '/tmp/a=b');
});

test('le chemin du programme et les arguments inconnus sont ignorés', () => {
  // En développement : electron . --windowed
  assert.equal(parseArgs(['electron', '.', '--windowed']).windowed, true);
  // Le premier élément est toujours le programme, jamais une option.
  assert.equal(parseArgs(['--windowed']).windowed, false);
  assert.equal(parseArgs([EXE, '--self-testing']).selfTest, false);
  assert.equal(parseArgs([EXE, '--inconnu', '--disable-gpu']).selfTest, false);
});

test('entrée invalide : valeurs par défaut', () => {
  const defaults = { windowed: false, devtools: false, selfTest: false, selfTestDir: null, statusFile: null };
  assert.deepEqual(parseArgs(undefined), defaults);
  assert.deepEqual(parseArgs([]), defaults);
});

test('--status-file=FICHIER : compte rendu de démarrage', () => {
  assert.equal(STATUS_FILE_FLAG, '--status-file');
  assert.equal(parseArgs([EXE, '--status-file=D:\\a\\out\\etat.json']).statusFile, 'D:\\a\\out\\etat.json');
  assert.equal(parseArgs([EXE, '--status-file=C:\\Mes documents\\a=b.json']).statusFile, 'C:\\Mes documents\\a=b.json');
  // Sans nom de fichier, l'option est sans effet.
  assert.equal(parseArgs([EXE, '--status-file']).statusFile, null);
  assert.equal(parseArgs([EXE, '--status-file=']).statusFile, null);
  assert.equal(parseArgs([EXE, '--status-files=x']).statusFile, null);
  // Elle ne change rien au mode d'affichage ni à l'auto-test.
  assert.deepEqual(parseArgs([EXE, '--status-file=etat.json']), {
    windowed: false,
    devtools: false,
    selfTest: false,
    selfTestDir: null,
    statusFile: 'etat.json',
  });
  assert.deepEqual(parseArgs([EXE, '--self-test=out', '--status-file=etat.json', '--windowed']), {
    windowed: true,
    devtools: false,
    selfTest: true,
    selfTestDir: 'out',
    statusFile: 'etat.json',
  });
});
