/**
 * Outils de la compilation automatique : exécution d'une étape avec journal
 * (scripts/ci-run.sh) et signalement de la cause d'un échec
 * (scripts/ci-annotate.mjs).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { annotation, cleanLog, escapeData, escapeProperty, failureAnnotations, tailChunks } from '../scripts/ci-annotate.mjs';
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

// Sous Windows, « bash » peut désigner le lanceur WSL plutôt que Git Bash : le
// script y est de toute façon exercé à chaque étape de la compilation automatique.
test('ci-run.sh : sortie recopiée, code de sortie transmis, échec annoté', { skip: process.platform === 'win32' }, () => {
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
