/**
 * Outils de la compilation automatique : exécution d'une étape avec journal
 * (scripts/ci-run.sh), signalement de la cause d'un échec et bilan d'une série
 * de tests (scripts/ci-annotate.mjs).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { annotation, cleanLog, escapeData, escapeProperty, failureAnnotations, tailChunks, testsAnnotations, testsOutcome } from '../scripts/ci-annotate.mjs';
import { fromRoot } from './helpers.mjs';

const ANNOTATE = fromRoot('scripts', 'ci-annotate.mjs');
const RUN = fromRoot('scripts', 'ci-run.sh');
const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-ci-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

test('échappement des commandes d’annotation', () => {
  assert.equal(escapeData('100 % sûr\nligne 2\r'), '100 %25 sûr%0Aligne 2%0D');
  assert.equal(escapeProperty('Échec : tests, étape 2'), 'Échec %3A tests%2C étape 2');
  assert.equal(annotation('error', 'Titre: a,b', 'ligne 1\nligne 2'), '::error title=Titre%3A a%2Cb::ligne 1%0Aligne 2');
  // Une annotation tient toujours sur une seule ligne.
  assert.ok(!annotation('notice', 'a\nb', 'c\r\nd').includes('\n'));
});

test('nettoyage d’une sortie de terminal', () => {
  assert.equal(cleanLog('\u001b[31mrouge\u001b[0m\r\nsuite\n\n\n\nfin\n'), 'rouge\nsuite\n\nfin');
});

test('seule la fin du journal est reprise, coupée en fin de ligne', () => {
  const lines = Array.from({ length: 400 }, (_, index) => `ligne ${String(index + 1).padStart(3, '0')} ${'x'.repeat(40)}`);
  const chunks = tailChunks(lines.join('\n'), 1000, 3);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000);
    assert.match(chunk, /^ligne \d{3} x+/, 'chaque morceau commence au début d’une ligne');
  }
  assert.ok(chunks.at(-1).endsWith(lines.at(-1)), 'le dernier morceau se termine par la dernière ligne');
  // Les morceaux se suivent sans trou ni répétition.
  const numbers = chunks
    .join('\n')
    .split('\n')
    .map((line) => Number(line.slice(6, 9)));
  assert.ok(numbers.length > 50);
  assert.deepEqual(
    numbers,
    Array.from({ length: numbers.length }, (_, index) => 400 - numbers.length + 1 + index),
  );

  assert.deepEqual(tailChunks('court'), ['court']);
  assert.deepEqual(tailChunks('\n\n'), []);
  assert.deepEqual(tailChunks('a\nb\nc', 1000, 1), ['a\nb\nc']);
  assert.equal(tailChunks('y'.repeat(5000), 1000, 3)[0].length, 1000, 'une ligne démesurée est tronquée');
});

test('annotations d’un échec : titre de l’étape, morceaux numérotés', () => {
  assert.deepEqual(failureAnnotations('tests automatiques', 'ℹ fail 1\n\n✖ un test\n  AssertionError: 1 !== 2\n'), [
    '::error title=Échec %3A tests automatiques::ℹ fail 1%0A%0A✖ un test%0A  AssertionError: 1 !== 2',
  ]);
  assert.deepEqual(failureAnnotations('étape', ''), ["::error title=Échec %3A étape::(la commande n'a rien affiché)"]);

  const long = failureAnnotations('fabrication', Array.from({ length: 900 }, (_, index) => `ligne ${index + 1} ${'x'.repeat(30)}`).join('\n'));
  assert.equal(long.length, 4);
  assert.match(long[0], /^::error title=Échec %3A fabrication \(1\/4\)::/);
  assert.match(long[3], /^::error title=Échec %3A fabrication \(4\/4\)::.*ligne 900 x+$/);
  for (const line of long) assert.ok(line.length < 4000 && !line.includes('\n'));
});

test('en ligne de commande : journal lu, nom de l’étape déduit du fichier', () => {
  const file = path.join(workDir, 'tests-automatiques.log');
  writeFileSync(file, 'première ligne\nERREUR : panne\n');

  const named = spawnSync(process.execPath, [ANNOTATE, file, 'auto-test-executable'], { encoding: 'utf8' });
  assert.equal(named.status, 0);
  assert.equal(named.stdout, '::error title=Échec %3A auto test executable::première ligne%0AERREUR : panne\n');

  const deduced = spawnSync(process.execPath, [ANNOTATE, file], { encoding: 'utf8' });
  assert.match(deduced.stdout, /^::error title=Échec %3A tests automatiques::/);

  const missing = spawnSync(process.execPath, [ANNOTATE, path.join(workDir, 'absent.log')], { encoding: 'utf8' });
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /^::error title=Échec %3A absent::\(journal illisible : /);

  assert.equal(spawnSync(process.execPath, [ANNOTATE], { encoding: 'utf8' }).status, 2);
});

// --- Bilan d'une série de tests ---------------------------------------------------------

/** Sortie de `node --test --test-reporter=spec`, telle qu'un terminal la reçoit (couleurs, fins de ligne de Windows). */
const SPEC_OUTPUT = [
  '\u001b[32m✔ réussi : un nom avec (des parenthèses) et # un dièse \u001b[90m(0.797671ms)\u001b[39m\u001b[39m',
  '﹣ ignoré sans motif (0.12099ms) # SKIP',
  '﹣ vrai disque : dossier dont l’accès est refusé (essai 2) (0.100551ms) # droits non applicables ici',
  '✔ à écrire (0.103772ms) # TODO',
  '﹣ ignoré depuis le test (12ms) # droits non applicables ici',
  '▶ groupe',
  '  ﹣ sous-test ignoré (0.975443ms) # autre motif',
  '  ✔ sous-test réussi (0.126974ms)',
  '✔ groupe (1.621683ms)',
  '✖ en échec (3.5ms)',
  '  ﹣ ceci n’est pas un test : aucune durée',
  'ℹ tests 9',
  'ℹ suites 0',
  'ℹ pass 3',
  'ℹ fail 1',
  'ℹ cancelled 0',
  'ℹ skipped 4',
  'ℹ todo 1',
  'ℹ duration_ms 66.142044',
  '',
  '✖ failing tests:',
  '',
  '✖ en échec (3.5ms)',
  '',
].join('\r\n');

test('bilan d’une série de tests : totaux, et nom des tests non exécutés avec leur motif', () => {
  assert.deepEqual(testsOutcome(SPEC_OUTPUT), {
    tests: 9,
    pass: 3,
    fail: 1,
    cancelled: 0,
    skipped: 4,
    todo: 1,
    notRun: [
      { name: 'ignoré sans motif', reason: '' },
      { name: 'vrai disque : dossier dont l’accès est refusé (essai 2)', reason: 'droits non applicables ici' },
      { name: 'ignoré depuis le test', reason: 'droits non applicables ici' },
      { name: 'sous-test ignoré', reason: 'autre motif' },
    ],
  });
  // Plusieurs bilans dans une même sortie : le dernier est celui de la série entière.
  assert.equal(testsOutcome(`ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n${SPEC_OUTPUT}`).tests, 9);
  assert.deepEqual(testsOutcome('ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n'), { tests: 2, pass: 2, fail: 0, skipped: 0, cancelled: 0, todo: 0, notRun: [] });
  // Une sortie qui n'est pas celle d'une série de tests, ou un bilan incomplet : rien.
  for (const other of ['', 'Auto-test réussi — 56/56 contrôles\n', 'ℹ tests 2\nℹ pass 2\n', '# tests 2\n# pass 2\n# fail 0\n# skipped 0\n', 'tests 2 pass 2 fail 0 skipped 0']) {
    assert.equal(testsOutcome(other), null, other);
  }
});

test('note d’une série de tests : ce qui a réussi sur la machine, et ce qui n’y a pas été exécuté, par motif', () => {
  assert.deepEqual(testsAnnotations(SPEC_OUTPUT, 'win32 x64, Node.js 22.0.0'), [
    '::notice title=Tests automatiques::' +
      [
        'Sur cette machine (win32 x64, Node.js 22.0.0) : 9 tests — 3 réussis, 1 en échec, 1 à écrire, 4 non exécutés.',
        'Non exécutés ici, et pourquoi :',
        '▸ sans motif indiqué :',
        '  ﹣ ignoré sans motif',
        '▸ droits non applicables ici (2 tests) :',
        '  ﹣ vrai disque : dossier dont l’accès est refusé (essai 2)',
        '  ﹣ ignoré depuis le test',
        '▸ autre motif :',
        '  ﹣ sous-test ignoré',
      ].join('%0A'),
  ]);
  // Tout a été exécuté : une seule ligne. La machine citée par défaut est celle qui exécute le script.
  assert.deepEqual(testsAnnotations('ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0\n', 'linux x64'), ['::notice title=Tests automatiques::Sur cette machine (linux x64) : 1 test — 1 réussi, aucun échec, tous exécutés.']);
  assert.match(
    testsAnnotations('ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ cancelled 2\nℹ skipped 1\n')[0],
    new RegExp(`^::notice title=Tests automatiques::Sur cette machine \\(${process.platform} ${process.arch}, Node\\.js ${process.versions.node.replaceAll('.', '\\.')}\\) : 3 tests — 0 réussi, aucun échec, 2 interrompus, 1 non exécuté\\.%0ANon exécutés ici \\(0 relevés dans la sortie, pour 1 annoncés\\) :$`),
  );
  // Une sortie qui n'est pas celle de tests : aucune note.
  assert.deepEqual(testsAnnotations('Auto-test réussi — 56/56 contrôles\n'), []);
});

test('note d’une série de tests : une longue liste est répartie sur plusieurs notes, sans couper un motif qui tient dans une note', () => {
  const skipped = (count, prefix, reason) => Array.from({ length: count }, (_, index) => `﹣ ${prefix} ${index + 1} ${'x'.repeat(60)} (1ms) # ${reason}`);
  const totals = (count) => `ℹ tests ${count}\nℹ pass 0\nℹ fail 0\nℹ skipped ${count}\n`;
  const messages = (notes) => notes.map((note) => note.slice(note.indexOf('::', 2) + 2).split('%0A'));

  // Deux motifs : le second ne tient pas à la suite du premier, il commence une nouvelle note.
  const two = testsAnnotations([...skipped(30, 'premier', 'motif A'), ...skipped(20, 'second', 'motif B'), totals(50)].join('\n'), 'machine');
  assert.equal(two.length, 2);
  assert.match(two[0], /^::notice title=Tests automatiques \(1\/2\)::Sur cette machine \(machine\) : 50 tests — 0 réussi, aucun échec, 50 non exécutés\.%0ANon exécutés ici, et pourquoi :%0A▸ motif A \(30 tests\) :%0A {2}﹣ premier 1 x+%0A/);
  assert.match(two[1], /^::notice title=Tests automatiques \(2\/2\)::▸ motif B \(20 tests\) :%0A {2}﹣ second 1 x+%0A/);
  assert.ok(two[0].endsWith(`﹣ premier 30 ${'x'.repeat(60)}`) && two[1].endsWith(`﹣ second 20 ${'x'.repeat(60)}`));
  for (const note of two) assert.ok(note.length < 4000 && !note.includes('\n'));

  // Un motif trop long pour une note est coupé en fin de ligne ; rien n'est perdu ni répété.
  const long = testsAnnotations([...skipped(100, 'test', 'motif unique'), totals(100)].join('\n'), 'machine');
  assert.equal(long.length, 3);
  for (const lines of messages(long)) assert.ok(lines.join('\n').length <= 3000);
  assert.deepEqual(
    messages(long)
      .flat()
      .filter((line) => line.startsWith('  ﹣ '))
      .map((line) => Number(line.split(' ')[4])),
    Array.from({ length: 100 }, (_, index) => index + 1),
  );

  // Au-delà de quatre notes, la liste s'arrête — et le dit.
  const huge = testsAnnotations([...skipped(400, 'test', 'motif unique'), totals(400)].join('\n'), 'machine');
  assert.equal(huge.length, 4);
  assert.match(huge[3], /^::notice title=Tests automatiques \(4\/4\)::.*%0A… et \d+ autres lignes\.$/);
  const listed = messages(huge).flat().filter((line) => line.startsWith('  ﹣ ')).length;
  assert.equal(listed + Number(/… et (\d+) autres lignes\.$/.exec(huge[3])[1]), 400);
});

test('en ligne de commande : bilan des tests lu dans un journal ; rien pour un autre journal', () => {
  const file = path.join(workDir, 'serie.log');
  writeFileSync(file, SPEC_OUTPUT);
  const run = (...args) => spawnSync(process.execPath, [ANNOTATE, ...args], { encoding: 'utf8' });

  const summary = run('--tests', file);
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(summary.stdout, `${testsAnnotations(SPEC_OUTPUT)[0]}\n`);
  assert.match(summary.stdout, /^::notice title=Tests automatiques::Sur cette machine \(.+\) : 9 tests — 3 réussis, 1 en échec, 1 à écrire, 4 non exécutés\.%0A/);

  // Un journal sans bilan, ou absent : rien n'est publié, et ce n'est pas une erreur.
  const other = path.join(workDir, 'autre.log');
  writeFileSync(other, 'Auto-test réussi — 56/56 contrôles\n');
  for (const quiet of [run('--tests', other), run('--tests', path.join(workDir, 'absent.log'))]) {
    assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', '']);
  }
  // Sans journal : rappel de l'utilisation.
  for (const wrong of [run('--tests'), run('--inconnue', file)]) {
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /^Utilisation : node scripts\/ci-annotate\.mjs JOURNAL \[NOM_DE_L_ETAPE\]\n\s+node scripts\/ci-annotate\.mjs --tests JOURNAL\n$/);
    assert.equal(wrong.stdout, '');
  }
});

// Sous Windows, « bash » peut désigner le lanceur WSL plutôt que Git Bash : le
// script y est de toute façon exercé à chaque étape de la compilation automatique.
const bashOnly = { skip: process.platform === 'win32' ? 'ci-run.sh : sous Windows, il est exercé par chaque étape de la compilation automatique' : false };

test('ci-run.sh : sortie recopiée, code de sortie transmis, échec annoté', bashOnly, () => {
  const logDir = path.join(workDir, 'journaux');
  const run = (...args) => spawnSync('bash', [RUN, ...args], { encoding: 'utf8', cwd: workDir, env: { ...process.env, CI_LOG_DIR: logDir } });

  const ok = run('etape-reussie', process.execPath, '-e', "console.log('sortie'); console.error('avertissement')");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /sortie/);
  assert.match(ok.stdout, /avertissement/, 'la sortie d’erreur est recopiée elle aussi');
  assert.ok(!ok.stdout.includes('::error'));
  assert.match(readFileSync(path.join(logDir, 'etape-reussie.log'), 'utf8'), /sortie\n/);

  const failed = run('etape-en-echec', process.execPath, '-e', "console.log('avant'); console.error('ERREUR : panne simulée'); process.exit(3)");
  assert.equal(failed.status, 3, 'le code de sortie de la commande est transmis');
  assert.match(failed.stdout, /^::error title=Échec %3A etape en echec::.*ERREUR : panne simulée$/m);
  assert.ok(existsSync(path.join(logDir, 'etape-en-echec.log')));

  const absent = run('commande-absente', 'commande-qui-n-existe-pas');
  assert.equal(absent.status, 127);
  assert.match(absent.stdout, /^::error title=Échec %3A commande absente::/m);

  assert.equal(run('nom-seul').status, 2);
});

test('ci-run.sh : après une série de tests, réussie ou non, son bilan est publié en note', bashOnly, () => {
  const logDir = path.join(workDir, 'journaux-tests');
  const run = (...args) => spawnSync('bash', [RUN, ...args], { encoding: 'utf8', cwd: workDir, env: { ...process.env, CI_LOG_DIR: logDir } });
  const output = path.join(workDir, 'sortie-des-tests.txt');
  writeFileSync(output, SPEC_OUTPUT);
  const print = `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(output)}, 'utf8'))`;
  const note = testsAnnotations(SPEC_OUTPUT)[0];

  const passed = run('tests-automatiques', process.execPath, '-e', print);
  assert.equal(passed.status, 0, passed.stderr);
  assert.ok(passed.stdout.endsWith(`\n${note}\n`), passed.stdout.replace(/^::/gm, ': :'));
  assert.ok(!passed.stdout.includes('::error'));

  // En échec : la fin du journal en erreur, puis le bilan.
  const failed = run('tests-automatiques', process.execPath, '-e', `${print}; process.exit(1)`);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^::error title=Échec %3A tests automatiques::/m);
  assert.ok(failed.stdout.endsWith(`\n${note}\n`));

  // Une étape qui n'est pas une série de tests : aucune note.
  const other = run('fabrication', process.execPath, '-e', "console.log('terminé')");
  assert.deepEqual([other.status, other.stdout], [0, 'terminé\n']);
});
