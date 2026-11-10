/**
 * Script de vérification de l'exécutable (scripts/check-exe.mjs).
 * Une fausse application (tests/fixtures/fake-app.mjs) imite les comportements
 * possibles de l'exécutable : le script ne doit conclure à une réussite que si
 * TOUT est conforme (code de sortie, rapport présent, contrôles réussis).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { fromRoot } from './helpers.mjs';

const SCRIPT = fromRoot('scripts', 'check-exe.mjs');
const FAKE_APP = fromRoot('tests', 'fixtures', 'fake-app.mjs');
const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-check-exe-'));

after(() => rmSync(workDir, { recursive: true, force: true }));

/** Lance le script contre la fausse application dans le mode donné. */
function run(mode, { timeout = 30, outDir = path.join(workDir, mode), env = {} } = {}) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, process.execPath, `--out=${outDir}`, `--timeout=${timeout}`, '--', FAKE_APP, mode],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '', ...env }, timeout: 60_000 },
  );
  return { code: result.status, output: `${result.stdout}\n${result.stderr}`, outDir };
}

test('réussite : tous les contrôles passent', () => {
  const { code, output } = run('pass');
  assert.equal(code, 0, output);
  assert.match(output, /✔ contrôle un/);
  assert.match(output, /✔ contrôle deux/);
  assert.match(output, /Contrôles : 2\/2/);
  assert.match(output, /Auto-test réussi/);
});

test('échec : un contrôle en erreur', () => {
  const { code, output } = run('fail');
  assert.equal(code, 1, output);
  assert.match(output, /✖ contrôle deux\s+→\s+\{"attendu":1\}/);
  assert.match(output, /Contrôles : 1\/2/);
  assert.match(output, /ne doit pas être distribué/);
});

test('échec : une erreur de console dans l’interface', () => {
  const { code, output } = run('console-error');
  assert.equal(code, 1, output);
  assert.match(output, /erreur : console : erreur simulée/);
});

test('échec : code de sortie 0 mais rapport en échec', () => {
  const { code, output } = run('lying-exit-code');
  assert.equal(code, 1, output);
});

test('échec : rapport « ok » mais code de sortie en erreur', () => {
  const { code, output } = run('lying-report');
  assert.equal(code, 1, output);
  assert.match(output, /Code de sortie de l'application : 3/);
});

test('échec : rapport sans aucun contrôle', () => {
  const { code, output } = run('empty-report');
  assert.equal(code, 1, output);
});

test('échec : l’application se termine sans écrire de rapport', () => {
  const { code, output } = run('silent');
  assert.equal(code, 1, output);
  assert.match(output, /sans écrire de rapport/);
});

test('échec : l’erreur fatale consignée par l’application est affichée', () => {
  const { code, output, outDir } = run('fatal');
  assert.equal(code, 1, output);
  assert.match(output, /sans écrire de rapport/);
  assert.match(output, /Erreur consignée par l'application :\s+Error: panne simulée\s+at start \(main\.js:1:1\)/);

  // Un journal d'erreur périmé ne doit pas être attribué au lancement suivant.
  const next = run('pass', { outDir });
  assert.equal(next.code, 0, next.output);
  assert.equal(existsSync(path.join(outDir, 'fatal-error.log')), false);
  assert.doesNotMatch(next.output, /panne simulée/);
});

test('échec : l’application ne se termine pas (délai dépassé)', () => {
  const { code, output } = run('hang', { timeout: 2 });
  assert.equal(code, 1, output);
  assert.match(output, /ne s'est pas terminée en 2 s/);
});

test('échec : exécutable introuvable', () => {
  const result = spawnSync(process.execPath, [SCRIPT, path.join(workDir, 'absent.exe'), `--out=${path.join(workDir, 'absent')}`], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Exécutable introuvable/);
});

test('un ancien rapport ne peut pas être pris pour le résultat du jour', () => {
  const outDir = path.join(workDir, 'stale');
  assert.equal(run('pass', { outDir }).code, 0);
  assert.ok(existsSync(path.join(outDir, 'result.json')));
  // Fichiers sans rapport avec l'auto-test : ils doivent être conservés.
  writeFileSync(path.join(outDir, 'notes.txt'), 'à conserver');
  writeFileSync(path.join(outDir, '01-bureau.png'), 'ancienne capture');

  const { code, output } = run('silent', { outDir });
  assert.equal(code, 1, output);
  assert.equal(existsSync(path.join(outDir, 'result.json')), false, 'ancien rapport effacé');
  assert.equal(existsSync(path.join(outDir, '01-bureau.png')), false, 'ancienne capture effacée');
  assert.equal(readFileSync(path.join(outDir, 'notes.txt'), 'utf8'), 'à conserver');
});

test('le résumé de compilation GitHub est renseigné', () => {
  const summary = path.join(workDir, 'summary.md');
  writeFileSync(summary, '');
  assert.equal(run('pass', { env: { GITHUB_STEP_SUMMARY: summary } }).code, 0);
  assert.match(readFileSync(summary, 'utf8'), /✅ Auto-test de l'exécutable : réussi/);
  assert.match(readFileSync(summary, 'utf8'), /\| contrôle un \| ✅ \|/);

  writeFileSync(summary, '');
  assert.equal(run('fail', { env: { GITHUB_STEP_SUMMARY: summary } }).code, 1);
  assert.match(readFileSync(summary, 'utf8'), /❌ Auto-test de l'exécutable : échec/);
  assert.match(readFileSync(summary, 'utf8'), /\| contrôle deux \| ❌/);
});

test('sur GitHub Actions, le résultat est publié en annotation', () => {
  // Les annotations sont des lignes « ::niveau title=…::texte » ; le texte ne doit
  // contenir aucun saut de ligne brut (ils sont encodés en %0A).
  const lines = (output) => output.split('\n').filter((line) => line.startsWith('::'));

  const passed = lines(run('pass', { env: { GITHUB_ACTIONS: 'true' } }).output);
  assert.equal(passed.length, 1);
  assert.match(passed[0], /^::notice title=Auto-test — node(\.exe)?::Auto-test réussi — 2\/2 contrôles · 0 captures · fenêtre 1600 × 900/);

  const failed = lines(run('fail', { env: { GITHUB_ACTIONS: 'true' } }).output);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^::error title=Auto-test — node(\.exe)?::Auto-test en échec — 1\/2 contrôles/);
  assert.match(failed[0], /%0A✖ contrôle deux → \{"attendu"%3A1\}|%0A✖ contrôle deux → \{"attendu":1\}/);

  const fatal = lines(run('fatal', { env: { GITHUB_ACTIONS: 'true' } }).output);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /^::error title=[^:]+::L'application s'est terminée \(code 1\) sans écrire de rapport[^\n]*%0A%0AError: panne simulée%0A/);

  assert.deepEqual(lines(run('pass').output), [], 'aucune annotation hors de GitHub Actions');
});

test('les mesures des captures figurent dans le compte rendu', () => {
  const { code, output } = run('pass-with-images', { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(code, 0, output);
  assert.match(output, /Contrôles : 1\/1 · captures : 2 de 1600 × 900 \(278 à 352 couleurs\) · fenêtre : 1600 × 900/);
  assert.match(output, /Moteur    : Electron 45\.2\.3 \(Chromium 156\.0\.0\.0\)/);
  assert.match(
    output,
    /^::notice title=[^:]+::Auto-test réussi — 1\/1 contrôles · 2 captures de 1600 × 900 \(278 à 352 couleurs\) · fenêtre 1600 × 900 · Electron 45\.2\.3 \(Chromium 156\.0\.0\.0\) · [\d.]+ s$/m,
  );
});
