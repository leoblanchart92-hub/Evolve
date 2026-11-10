/**
 * Vérification « les réglages survivent à un redémarrage »
 * (scripts/check-settings.mjs). Une fausse application
 * (tests/fixtures/fake-app.mjs) imite les comportements possibles de
 * l'exécutable : le script ne doit conclure à une réussite que si les réglages
 * sont réellement sur le disque après le premier lancement et retrouvés par
 * le second — et il ne doit jamais toucher à des réglages existants.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { fromRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { CHANGED_SETTINGS } = require('../src/main/selftest-settings.js');

const SCRIPT = fromRoot('scripts', 'check-settings.mjs');
const FAKE_APP = fromRoot('tests', 'fixtures', 'fake-app.mjs');
const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-check-settings-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

let sequence = 0;

/**
 * Lance le script contre la fausse application dans le mode donné.
 * @param {string} mode
 * @param {object} [options]
 * @param {string|null} [options.settingsDir]  dossier de réglages demandé (`null` : celui par défaut)
 * @param {number} [options.timeout]           durée maximale de chaque lancement, en secondes
 * @param {string[]} [options.appArgs]         arguments supplémentaires transmis à l'application
 */
function run(mode, { settingsDir = null, timeout = 30, appArgs = [] } = {}) {
  const base = path.join(workDir, `essai-${(sequence += 1)}`);
  const outDir = path.join(base, 'resultats');
  const log = path.join(base, 'lancements.log');
  // Dossier temporaire privé : on peut vérifier que le script n'y laisse rien.
  const temp = path.join(base, 'temp');
  mkdirSync(temp, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [SCRIPT, process.execPath, `--out=${outDir}`, `--timeout=${timeout}`, ...(settingsDir ? [`--settings-dir=${settingsDir}`] : []), '--', FAKE_APP, mode, ...appArgs],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '', FAKE_APP_LOG: log, TMPDIR: temp, TEMP: temp, TMP: temp },
      timeout: 120_000,
    },
  );
  const launches = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')[0]) : [];
  const usedDir = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n')[0].split(' ').slice(1).join(' ') : null;
  return { code: result.status, output: `${result.stdout}\n${result.stderr}`, outDir, temp, launches, usedDir, base };
}

test('réussite : réglages enregistrés par le premier lancement, retrouvés par le second', () => {
  const { code, output, outDir, launches } = run('settings-ok');
  assert.equal(code, 0, output);
  assert.deepEqual(launches, ['settings-write', 'settings-read'], 'deux lancements distincts, dans cet ordre');
  assert.match(output, /Premier lancement/);
  assert.match(output, /settings\.json enregistré \(\d+ octets\), seul dans son dossier/);
  assert.match(output, /quick\.nightLight = true/);
  assert.match(output, /quick\.brightness = 60/);
  assert.match(output, /✔ Réglages conservés après redémarrage/);
  assert.doesNotMatch(output, /✖/);

  // Les deux rapports d'auto-test et une copie du fichier des réglages sont conservés.
  assert.equal(readJson(path.join(outDir, '1-modification', 'result.json')).scenario, 'settings-write');
  assert.equal(readJson(path.join(outDir, '2-relance', 'result.json')).scenario, 'settings-read');
  assert.deepEqual(readJson(path.join(outDir, 'settings.json')).values, CHANGED_SETTINGS);
});

test('par défaut : dossier temporaire neuf, entièrement retiré à la fin', () => {
  const ok = run('settings-ok');
  assert.equal(ok.code, 0, ok.output);
  assert.equal(path.dirname(ok.usedDir), ok.temp, 'dossier créé dans le dossier temporaire');
  assert.match(path.basename(ok.usedDir), /^evolve-reglages-/);
  assert.deepEqual(readdirSync(ok.temp), [], 'rien ne reste après une réussite');

  const failed = run('settings-read-fails');
  assert.equal(failed.code, 1, failed.output);
  assert.deepEqual(readdirSync(failed.temp), [], 'rien ne reste après un échec');
  assert.deepEqual(readJson(path.join(failed.outDir, 'settings.json')).values, CHANGED_SETTINGS, 'le fichier est tout de même conservé pour examen');
});

test('--settings-dir : dossier inexistant créé puis retiré ; dossier existant conservé avec son contenu', () => {
  // Dossier inexistant (cas de %APPDATA%\Evolve sur la machine de compilation).
  const base = path.join(workDir, 'profil', 'AppData', 'Roaming');
  mkdirSync(base, { recursive: true });
  const fresh = path.join(base, 'Evolve');
  const first = run('settings-ok', { settingsDir: fresh });
  assert.equal(first.code, 0, first.output);
  assert.equal(first.usedDir, fresh, 'le dossier demandé est transmis à l’application');
  assert.equal(existsSync(fresh), false, 'le dossier créé pour la vérification est retiré');
  assert.deepEqual(readdirSync(base), []);
  assert.deepEqual(readdirSync(first.temp), [], 'aucun dossier temporaire créé pour rien');

  // Dossier existant, avec d'autres fichiers : ils ne sont ni comptés, ni touchés.
  const existing = path.join(workDir, 'dossier-existant');
  mkdirSync(path.join(existing, 'sous-dossier'), { recursive: true });
  writeFileSync(path.join(existing, 'notes.txt'), 'à garder');
  writeFileSync(path.join(existing, 'settings.corrupt.json'), 'ancienne copie de secours');
  const second = run('settings-ok', { settingsDir: existing });
  assert.equal(second.code, 0, second.output);
  assert.deepEqual(readdirSync(existing).sort(), ['notes.txt', 'settings.corrupt.json', 'sous-dossier']);
  assert.equal(readFileSync(path.join(existing, 'notes.txt'), 'utf8'), 'à garder');
  assert.equal(readFileSync(path.join(existing, 'settings.corrupt.json'), 'utf8'), 'ancienne copie de secours');
});

test('des réglages existants ne sont jamais écrasés : refus avant tout lancement', () => {
  const dir = path.join(workDir, 'reglages-existants');
  mkdirSync(dir, { recursive: true });
  const mine = '{ "schema": 1, "values": { "quick.volume": 12 } }';
  writeFileSync(path.join(dir, 'settings.json'), mine);

  const { code, output, launches, outDir } = run('settings-ok', { settingsDir: dir });
  assert.equal(code, 1, output);
  assert.match(output, /existe déjà : cette vérification n'écrase jamais des réglages existants/);
  assert.deepEqual(launches, [], 'l’application n’a pas été lancée');
  assert.equal(readFileSync(path.join(dir, 'settings.json'), 'utf8'), mine, 'réglages intacts');
  assert.deepEqual(readdirSync(dir), ['settings.json']);
  assert.equal(existsSync(path.join(outDir, 'settings.json')), false, 'les réglages de l’utilisateur ne sont pas copiés ailleurs');
});

test('échec : le premier lancement n’enregistre rien sur le disque', () => {
  for (const mode of ['settings-not-saved', 'settings-ignores-dir']) {
    const { code, output, launches } = run(mode);
    assert.equal(code, 1, output);
    assert.match(output, /Après le premier lancement : aucun fichier settings\.json/);
    assert.match(output, /ne doit pas être distribué/);
    assert.deepEqual(launches, ['settings-write'], 'inutile de relancer');
  }
});

test('échec : le fichier ne contient pas exactement les réglages modifiés', () => {
  for (const mode of ['settings-wrong-values', 'settings-missing-value']) {
    const { code, output, launches } = run(mode);
    assert.equal(code, 1, output);
    assert.match(output, /ne contient pas exactement les réglages modifiés/);
    assert.match(output, /attendu {2}: \{"desktop\.widgetsVisible":false/);
    assert.deepEqual(launches, ['settings-write']);
  }
});

test('échec : fichier tronqué, format ou version inattendus', () => {
  const cases = { 'settings-bad-json': /settings\.json illisible/, 'settings-bad-schema': /format du fichier inattendu \(2\)/, 'settings-bad-version': /version notée dans le fichier inattendue \("0\.0\.1"\)/ };
  for (const [mode, message] of Object.entries(cases)) {
    const { code, output, launches } = run(mode);
    assert.equal(code, 1, output);
    assert.match(output, message);
    assert.deepEqual(launches, ['settings-write']);
  }
});

test('échec : l’application laisse autre chose que settings.json dans le dossier des réglages', () => {
  const dir = path.join(workDir, 'dossier-avec-intrus');
  const { code, output } = run('settings-extra-file', { settingsDir: dir });
  assert.equal(code, 1, output);
  assert.match(output, /contient autre chose que settings\.json : debug\.log, settings\.json/);
  // Le fichier inattendu est laissé en place pour examen ; seul le fichier des réglages est retiré.
  assert.deepEqual(readdirSync(dir), ['debug.log']);
  assert.ok(output.includes(`Laissé en place, à examiner : ${path.join(dir, 'debug.log')}`), output);
});

test('refus : le dossier et le scénario de chaque lancement ne se choisissent pas dans les arguments de l’application', () => {
  // Transmise à l'application, l'option prendrait le pas sur celle du script :
  // la vérification inspecterait un dossier que l'application n'utilise pas.
  const elsewhere = path.join(workDir, 'ailleurs');
  for (const [argument, name] of [
    [`--settings-dir=${elsewhere}`, '--settings-dir'],
    ['--self-test-scenario=full', '--self-test-scenario'],
    ['--self-test', '--self-test'],
    ['--self-test=dossier', '--self-test'],
  ]) {
    const { code, output, launches, temp } = run('settings-ok', { appArgs: [argument] });
    assert.equal(code, 1, output);
    assert.ok(output.includes(`Option « ${name} » réservée à ce script`), output);
    assert.deepEqual(launches, [], `${argument} : aucun lancement`);
    assert.deepEqual(readdirSync(temp), [], `${argument} : le dossier temporaire créé est retiré`);
  }
  assert.ok(!existsSync(elsewhere));

  // Les autres arguments sont transmis tels quels.
  const { code, output, launches } = run('settings-ok', { appArgs: ['--windowed', '--settings-directory=x'] });
  assert.equal(code, 0, output);
  assert.deepEqual(launches, ['settings-write', 'settings-read']);
});

test('échec : un lancement en échec fait échouer la vérification', () => {
  const first = run('settings-write-fails');
  assert.equal(first.code, 1, first.output);
  assert.match(first.output, /Premier lancement en échec/);
  assert.deepEqual(first.launches, ['settings-write']);

  const second = run('settings-read-fails');
  assert.equal(second.code, 1, second.output);
  assert.match(second.output, /Second lancement en échec : l’interface n’a pas retrouvé les réglages enregistrés/);
  assert.deepEqual(second.launches, ['settings-write', 'settings-read']);
});

test('échec : le second lancement modifie ou supprime le fichier alors que rien n’a changé', () => {
  const rewritten = run('settings-rewritten');
  assert.equal(rewritten.code, 1, rewritten.output);
  assert.match(rewritten.output, /Le second lancement a modifié settings\.json alors qu'aucun réglage n'a changé/);

  const deleted = run('settings-deleted');
  assert.equal(deleted.code, 1, deleted.output);
  assert.match(deleted.output, /Après le second lancement : aucun fichier settings\.json/);
});

test('application bloquée : la durée maximale est transmise, le lancement est interrompu et la vérification échoue', () => {
  const started = Date.now();
  const { code, output, temp } = run('hang', { timeout: 1 });
  assert.equal(code, 1, output);
  assert.match(output, /ne s'est pas terminée en 1 s/);
  assert.match(output, /Premier lancement en échec/);
  assert.ok(Date.now() - started < 20_000, 'sans attendre la durée par défaut');
  assert.deepEqual(readdirSync(temp), [], 'le dossier temporaire est retiré même dans ce cas');
});

test('sur GitHub Actions : résumé et annotation, en réussite comme en échec', () => {
  const summary = path.join(workDir, 'resume.md');
  const runCi = (mode) => {
    const base = path.join(workDir, `ci-${(sequence += 1)}`);
    mkdirSync(base, { recursive: true });
    return spawnSync(process.execPath, [SCRIPT, process.execPath, `--out=${path.join(base, 'out')}`, `--settings-dir=${path.join(base, 'reglages')}`, '--', FAKE_APP, mode], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: 'true' },
      timeout: 120_000,
    });
  };

  const ok = runCi('settings-ok');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^::notice title=Réglages et redémarrage — node[^:]*::Réglages conservés après redémarrage/m);
  assert.match(readFileSync(summary, 'utf8'), /### ✅ Réglages et redémarrage : réussi[\s\S]*\| `quick\.volume` \| `35` \|/);
  // Chaque lancement publie aussi son propre résultat, sous un titre qui le distingue de l'auto-test complet.
  assert.deepEqual(
    [...ok.stdout.matchAll(/^::notice title=([^:]+?) — node[^:]*::/gm)].map((match) => match[1]),
    ['Auto-test « réglages modifiés »', 'Auto-test « réglages retrouvés »', 'Réglages et redémarrage'],
  );
  assert.deepEqual(
    [...readFileSync(summary, 'utf8').matchAll(/^### (.+)$/gm)].map((match) => match[1]),
    ["✅ Auto-test « réglages modifiés » de l'exécutable : réussi", "✅ Auto-test « réglages retrouvés » de l'exécutable : réussi", '✅ Réglages et redémarrage : réussi'],
  );

  const failed = runCi('settings-not-saved');
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^::error title=Réglages et redémarrage — node[^:]*::Après le premier lancement/m);
  assert.match(readFileSync(summary, 'utf8'), /### ❌ Réglages et redémarrage : échec/);
});
