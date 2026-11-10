/** Options de la ligne de commande de l'application. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { parseArgs, SELF_TEST_FLAG, STATUS_FILE_FLAG, SETTINGS_DIR_FLAG, SELF_TEST_SCENARIO_FLAG } = require('../src/main/args.js');

const EXE = 'C:\\Temp\\Evolve.exe';

/** Valeur de chaque option quand aucune n'est donnée. */
const DEFAULTS = Object.freeze({
  windowed: false,
  devtools: false,
  selfTest: false,
  selfTestDir: null,
  selfTestScenario: null,
  statusFile: null,
  settingsDir: null,
});

test('sans option : plein écran, pas d’auto-test', () => {
  assert.deepEqual(parseArgs([EXE]), DEFAULTS);
});

test('--windowed et --devtools', () => {
  assert.equal(parseArgs([EXE, '--windowed']).windowed, true);
  assert.equal(parseArgs([EXE, '--devtools']).devtools, true);
  assert.deepEqual(parseArgs([EXE, '--devtools', '--windowed']), { ...DEFAULTS, windowed: true, devtools: true });
});

test('--self-test sans dossier', () => {
  assert.equal(SELF_TEST_FLAG, '--self-test');
  assert.deepEqual(parseArgs([EXE, '--self-test']), { ...DEFAULTS, selfTest: true });
  assert.deepEqual(parseArgs([EXE, '--self-test=']), { ...DEFAULTS, selfTest: true });
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
  assert.deepEqual(parseArgs(undefined), DEFAULTS);
  assert.deepEqual(parseArgs([]), DEFAULTS);
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
  assert.deepEqual(parseArgs([EXE, '--status-file=etat.json']), { ...DEFAULTS, statusFile: 'etat.json' });
  assert.deepEqual(parseArgs([EXE, '--self-test=out', '--status-file=etat.json', '--windowed']), {
    ...DEFAULTS,
    windowed: true,
    selfTest: true,
    selfTestDir: 'out',
    statusFile: 'etat.json',
  });
});

test('--settings-dir=DOSSIER : emplacement des réglages', () => {
  assert.equal(SETTINGS_DIR_FLAG, '--settings-dir');
  assert.equal(parseArgs([EXE, '--settings-dir=C:\\Users\\Léo\\AppData\\Roaming\\Evolve']).settingsDir, 'C:\\Users\\Léo\\AppData\\Roaming\\Evolve');
  assert.equal(parseArgs([EXE, '--settings-dir=E:\\Ma clé\\réglages=perso']).settingsDir, 'E:\\Ma clé\\réglages=perso');
  assert.equal(parseArgs([EXE, '--settings-dir=reglages']).settingsDir, 'reglages');
  // Sans dossier, l'option est sans effet : l'emplacement habituel est utilisé.
  assert.equal(parseArgs([EXE, '--settings-dir']).settingsDir, null);
  assert.equal(parseArgs([EXE, '--settings-dir=']).settingsDir, null);
  assert.equal(parseArgs([EXE, '--settings-directory=x']).settingsDir, null);
  // Elle ne change rien d'autre.
  assert.deepEqual(parseArgs([EXE, '--settings-dir=reglages']), { ...DEFAULTS, settingsDir: 'reglages' });
});

test('--self-test-scenario=NOM : scénario de l’auto-test, sans le déclencher', () => {
  assert.equal(SELF_TEST_SCENARIO_FLAG, '--self-test-scenario');
  assert.deepEqual(parseArgs([EXE, '--self-test=out', '--self-test-scenario=settings-write', '--settings-dir=d']), {
    ...DEFAULTS,
    selfTest: true,
    selfTestDir: 'out',
    selfTestScenario: 'settings-write',
    settingsDir: 'd',
  });
  // Le nom du scénario n'est jamais pris pour le dossier des résultats, ni l'inverse.
  assert.deepEqual(parseArgs([EXE, '--self-test-scenario=settings-read', '--self-test']), { ...DEFAULTS, selfTest: true, selfTestScenario: 'settings-read' });
  // Seul, il ne lance pas d'auto-test.
  assert.deepEqual(parseArgs([EXE, '--self-test-scenario=settings-read']), { ...DEFAULTS, selfTestScenario: 'settings-read' });
  assert.equal(parseArgs([EXE, '--self-test', '--self-test-scenario=']).selfTestScenario, null);
});
