/**
 * Vérification « un dossier Documents absent n'est jamais recréé »
 * (scripts/check-documents.mjs). Une fausse application
 * (tests/fixtures/fake-app.mjs) imite les comportements possibles de
 * l'exécutable : le script ne doit conclure à une réussite que si le dossier
 * est réellement absent du disque après le lancement — quoi qu'en dise
 * l'application — et il doit toujours remettre en place, intact, le dossier
 * qu'il a mis de côté.
 *
 * Ces essais portent sur un dossier d'essai (option --folder) : le véritable
 * dossier Documents du compte n'est jamais touché ici.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { fromRoot, readText } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { SCENARIO, CHECKS } = require('../src/main/selftest-documents.js');

const SCRIPT = fromRoot('scripts', 'check-documents.mjs');
const FAKE_APP = fromRoot('tests', 'fixtures', 'fake-app.mjs');
const ASIDE = 'Documents.mis-de-cote-par-la-verification-evolve';
const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-check-documents-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Contenu complet d'un dossier : chemin relatif → contenu du fichier (`null` pour un dossier). */
function tree(dir, prefix = '') {
  const found = {};
  if (!existsSync(dir)) return found;
  for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}${item.name}`;
    if (item.isDirectory()) {
      found[`${relative}/`] = null;
      Object.assign(found, tree(path.join(dir, item.name), `${relative}/`));
    } else {
      found[relative] = readFileSync(path.join(dir, item.name), 'utf8');
    }
  }
  return found;
}

/** Contenu du dossier Documents d'essai — et de ce qui l'entoure. */
const DOCUMENTS = { 'Photos/': null, 'Photos/vacances.jpg': 'image', 'Rapport.txt': 'rapport annuel' };
const PROFILE = { 'Bureau/': null, 'Bureau/Notes.txt': 'notes', 'Documents/': null, ...Object.fromEntries(Object.entries(DOCUMENTS).map(([name, value]) => [`Documents/${name}`, value])), 'ntuser.ini': 'réglages' };

let sequence = 0;

/**
 * Lance le script contre la fausse application dans le mode donné, sur un
 * profil d'essai neuf.
 * @param {string} mode
 * @param {object} [options]
 * @param {boolean} [options.present]    le dossier Documents existe avant la vérification
 * @param {boolean} [options.useFolder]  passer --folder (sinon : le script vise le vrai dossier du compte)
 * @param {(profile: string) => void} [options.prepare]  modifie le profil d'essai avant le lancement
 * @param {string[]} [options.appArgs]   arguments supplémentaires transmis à l'application
 * @param {object} [options.env]         variables d'environnement supplémentaires
 */
function run(mode, { present = true, useFolder = true, prepare = null, appArgs = [], env = {} } = {}) {
  const base = path.join(workDir, `essai-${(sequence += 1)}`);
  const profile = path.join(base, 'profil');
  const folder = path.join(profile, 'Documents');
  const outDir = path.join(base, 'resultats');
  const log = path.join(base, 'lancements.log');
  const temp = path.join(base, 'temp');
  mkdirSync(temp, { recursive: true });
  for (const [name, content] of Object.entries(PROFILE)) {
    if (!present && name.startsWith('Documents/')) continue;
    const target = path.join(profile, name);
    if (content === null) mkdirSync(target, { recursive: true });
    else writeFileSync(target, content);
  }
  prepare?.(profile);
  const before = tree(profile);
  const stamp = present ? statSync(path.join(folder, 'Rapport.txt')).mtimeMs : null;

  const result = spawnSync(
    process.execPath,
    [SCRIPT, process.execPath, `--out=${outDir}`, '--timeout=30', '--idle=0.05', ...(useFolder ? [`--folder=${folder}`] : []), '--', FAKE_APP, mode, ...appArgs],
    {
      encoding: 'utf8',
      // GITHUB_ACTIONS vide : même sur la machine de compilation, ces essais ne visent jamais le vrai dossier Documents.
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '', FAKE_APP_DOCUMENTS: folder, FAKE_APP_LOG: log, TMPDIR: temp, TEMP: temp, TMP: temp, ...env },
      timeout: 120_000,
    },
  );
  const launches = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { code: result.status, output: `${result.stdout}\n${result.stderr}`, profile, folder, outDir, launches, before, after: tree(profile), stamp };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('réussite : dossier mis de côté, ouvert dans l’application, toujours absent, puis remis en place intact', () => {
  const { code, output, folder, outDir, launches, before, after: later, stamp } = run('documents-ok');
  assert.equal(code, 0, output);
  // Un seul lancement, avec le scénario prévu, alors que le dossier était réellement absent.
  assert.deepEqual(launches, [`${SCENARIO} absent`]);
  assert.match(output, /── 1\. Le dossier Documents est mis de côté ──/);
  assert.match(output, /✔ renommé en Documents\.mis-de-cote-par-la-verification-evolve \(2 éléments, contenu non touché\)/);
  assert.match(output, /✔ toujours absent 0,05 s plus tard : cette machine ne le recrée pas d'elle-même/);
  assert.match(output, /Auto-test « dossier Documents absent »/);
  assert.match(output, /✔ le dossier Documents est toujours absent : .*Documents n'a pas été recréé/);
  assert.match(output, /✔ rien n'est apparu ni n'a disparu dans .*profil \(3 éléments, liste identique\)/);
  assert.match(output, /✔ le contenu mis de côté est intact \(2 éléments\)/);
  assert.match(output, /✔ .*Documents est de nouveau en place, avec son contenu/);
  assert.match(output, /✔ Dossier Documents absent : jamais recréé/);
  assert.doesNotMatch(output, /✖/);

  // Le dossier est revenu, à l'identique — fichiers non réécrits — et rien d'autre n'a changé.
  assert.deepEqual(later, before);
  assert.equal(statSync(path.join(folder, 'Rapport.txt')).mtimeMs, stamp);
  // Le rapport de l'application est conservé avec les résultats.
  assert.equal(readJson(path.join(outDir, 'result.json')).scenario, SCENARIO);
});

test('dossier déjà absent de la machine : rien à mettre de côté, et il reste absent', () => {
  const { code, output, folder, launches, before, after: later } = run('documents-ok', { present: false });
  assert.equal(code, 0, output);
  assert.deepEqual(launches, [`${SCENARIO} absent`]);
  assert.match(output, /✔ déjà absent de cette machine : rien à mettre de côté/);
  assert.match(output, /✔ rien à remettre en place/);
  assert.match(output, /✔ Dossier Documents absent : jamais recréé/);
  assert.equal(existsSync(folder), false);
  assert.deepEqual(later, before);
});

test('le défaut corrigé : une application qui recrée le dossier est refusée — même si elle annonce une réussite', () => {
  for (const mode of ['documents-recreated', 'documents-recreated-quietly']) {
    const { code, output, launches, before, after: later } = run(mode);
    assert.equal(code, 1, `${mode}\n${output}`);
    assert.deepEqual(launches, [`${SCENARIO} absent`], mode);
    assert.match(output, /✖ Le dossier Documents a été recréé pendant le lancement d'Evolve : .*Documents \(dossier de 0 élément, créé à \d{4}-/, mode);
    assert.match(output, /Un dossier absent doit le rester : l'explorateur est en lecture seule\./, mode);
    assert.match(output, /l’exécutable ne doit pas être distribué/, mode);
    assert.doesNotMatch(output, /jamais recréé/, mode);
    // Le dossier vide recréé est retiré, et le vrai dossier remis en place avec son contenu.
    assert.deepEqual(later, before, mode);
  }
  // Seul le constat sur le disque distingue ce cas : l'application, elle, annonçait une réussite.
  const quiet = run('documents-recreated-quietly');
  assert.match(quiet.output, /✔ Auto-test réussi\./);
  assert.equal(quiet.code, 1);
});

test('dossier recréé avec du contenu : rien n’est effacé — il est conservé sous un autre nom, et le vrai dossier revient', () => {
  const { code, output, profile, after: later } = run('documents-recreated-filled');
  assert.equal(code, 1, output);
  assert.match(output, /✖ Le dossier Documents a été recréé pendant le lancement d'Evolve : .*\(dossier de 1 élément, créé à /);
  const kept = readdirSync(profile).filter((name) => name.startsWith('Documents.recree-pendant-la-verification-evolve-'));
  assert.equal(kept.length, 1, output);
  assert.deepEqual(readdirSync(path.join(profile, kept[0])), ['desktop.ini']);
  // Le vrai dossier, intact, a repris sa place.
  for (const [name, content] of Object.entries(DOCUMENTS)) assert.equal(later[`Documents/${name}`], content, name);
  assert.equal(existsSync(path.join(profile, ASIDE)), false);

  // Un fichier créé à la place du dossier : même refus, même remise en place.
  const asFile = run('documents-recreated-as-file');
  assert.equal(asFile.code, 1, asFile.output);
  assert.match(asFile.output, /✖ Le dossier Documents a été recréé pendant le lancement d'Evolve : .*\(fichier, créé à /);
  for (const [name, content] of Object.entries(DOCUMENTS)) assert.equal(asFile.after[`Documents/${name}`], content, name);
  assert.equal(readdirSync(asFile.profile).filter((name) => name.startsWith('Documents.recree-')).length, 1);
});

test('rien d’autre ne doit apparaître : un dossier créé à côté, ou un dossier mis de côté modifié, font échouer', () => {
  const beside = run('documents-other-folder');
  assert.equal(beside.code, 1, beside.output);
  assert.match(beside.output, /✖ Le contenu de .*profil a changé pendant le lancement d'Evolve :\n\s+apparu : Mes documents\//);
  // Le dossier Documents est tout de même remis en place.
  for (const [name, content] of Object.entries(DOCUMENTS)) assert.equal(beside.after[`Documents/${name}`], content, name);

  const touched = run('documents-touches-aside');
  assert.equal(touched.code, 1, touched.output);
  assert.match(touched.output, /✖ Le contenu du dossier mis de côté a changé pendant le lancement d'Evolve :\n\s+apparu : desktop\.ini/);
  assert.equal(existsSync(path.join(touched.folder, 'Rapport.txt')), true);

  const emptied = run('documents-empties-aside');
  assert.equal(emptied.code, 1, emptied.output);
  assert.match(emptied.output, /✖ Le contenu du dossier mis de côté a changé pendant le lancement d'Evolve :\n\s+disparu : Rapport\.txt/);

  // Dossier mis de côté déplacé par l'application : signalé, avec l'endroit où le retrouver.
  const moved = run('documents-moves-aside');
  assert.equal(moved.code, 1, moved.output);
  assert.match(moved.output, /apparu : Ailleurs\//);
  assert.match(moved.output, /disparu : Documents\.mis-de-cote-par-la-verification-evolve\//);
  assert.match(moved.output, /Le dossier mis de côté n'a pas pu être remis en place/);
});

test('l’application doit aussi annoncer le dossier absent : message non affiché, contrôle manquant ou autre scénario font échouer', () => {
  const silent = run('documents-no-message');
  assert.equal(silent.code, 1, silent.output);
  assert.match(silent.output, /✔ le dossier Documents est toujours absent/);
  assert.match(silent.output, /✖ Le lancement d'Evolve est en échec : le dossier Documents absent n'a pas été annoncé comme prévu/);
  assert.deepEqual(silent.after, silent.before);

  const partial = run('documents-check-missing');
  assert.equal(partial.code, 1, partial.output);
  assert.ok(partial.output.includes(`✖ Contrôles absents du rapport de l'application :\n  ${CHECKS.desktop}`), partial.output);
  assert.deepEqual(partial.after, partial.before);

  const other = run('documents-wrong-scenario');
  assert.equal(other.code, 1, other.output);
  assert.match(other.output, /✖ L'application n'a pas exécuté le scénario demandé \(« documents-missing »\) : "full"\./);
  assert.deepEqual(other.after, other.before);

  // Application qui ne démarre pas, ou ne rend aucun rapport.
  for (const mode of ['fatal', 'silent']) {
    const broken = run(mode);
    assert.equal(broken.code, 1, `${mode}\n${broken.output}`);
    assert.match(broken.output, /✖ Le lancement d'Evolve est en échec/, mode);
    assert.deepEqual(broken.after, broken.before, mode);
  }
});

test('le vrai dossier Documents du compte n’est visé que sur la machine de compilation : ailleurs, le script refuse', () => {
  const { code, output, launches, before, after: later } = run('documents-ok', { useFolder: false });
  assert.equal(code, 1, output);
  assert.match(output, /réservée à la\s+machine de compilation \(GitHub Actions, sous Windows\) et ne touche jamais au dossier Documents d’un autre ordinateur/);
  assert.match(output, /--folder=DOSSIER/);
  assert.deepEqual(launches, [], 'application jamais lancée');
  assert.deepEqual(later, before);

  assert.match(output, /la vérification n’a pas pu avoir lieu/);
  assert.doesNotMatch(output, /ne doit pas être distribué/);

  // Le texte du script le garantit : sans --folder, il exige à la fois Windows et GitHub Actions.
  const source = readText('scripts', 'check-documents.mjs');
  assert.match(source, /if \(process\.platform !== 'win32' \|\| process\.env\.GITHUB_ACTIONS !== 'true'\) \{\s+await refuse\(/);
});

test('situations refusées avant tout lancement : vérification interrompue, emplacement inutilisable, options réservées', () => {
  // Une vérification précédente a été interrompue : son dossier mis de côté est toujours là.
  const interrupted = run('documents-ok', { prepare: (profile) => mkdirSync(path.join(profile, ASIDE)) });
  assert.equal(interrupted.code, 1, interrupted.output);
  assert.match(interrupted.output, /existe déjà : une vérification précédente a été interrompue\. Remettez ce dossier en place \(renommez-le en Documents\)/);
  assert.deepEqual(interrupted.launches, []);
  assert.deepEqual(interrupted.after, interrupted.before, 'rien n’est touché');

  // « Documents » est un fichier.
  const file = run('documents-ok', { present: false, prepare: (profile) => writeFileSync(path.join(profile, 'Documents'), '') });
  assert.equal(file.code, 1, file.output);
  assert.match(file.output, /Documents n'est pas un dossier\./);
  assert.deepEqual(file.launches, []);
  assert.deepEqual(file.after, file.before);

  // Dossier parent inexistant.
  const nowhere = run('documents-ok', { prepare: (profile) => rmSync(profile, { recursive: true }), present: false });
  assert.equal(nowhere.code, 1, nowhere.output);
  assert.match(nowhere.output, /✖ Dossier introuvable : .*profil/);
  assert.deepEqual(nowhere.launches, []);

  // Le scénario est fixé par le script : il ne peut pas être remplacé.
  for (const reserved of ['--self-test-scenario=full', '--self-test=ailleurs']) {
    const refused = run('documents-ok', { appArgs: [reserved] });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /réservée à ce script/, reserved);
    assert.deepEqual(refused.launches, [], reserved);
    assert.deepEqual(refused.after, refused.before, reserved);
  }
});

test('compilation GitHub Actions : le constat est annoncé par une annotation et dans le résumé', () => {
  const summary = path.join(workDir, 'resume.md');
  // --folder est passé : même avec GITHUB_ACTIONS, c'est le dossier d'essai qui est mis de côté.
  const passed = run('documents-ok', { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(passed.code, 0, passed.output);
  const notice = passed.output.split('\n').find((line) => line.startsWith('::notice title=Dossier Documents absent — '));
  assert.ok(notice, passed.output);
  assert.match(notice, /::Dossier Documents absent : jamais recréé%0A✔ dossier Documents mis de côté/);
  assert.match(notice, /après le lancement : dossier toujours absent du disque — Evolve ne l'a pas recréé/);
  assert.match(readFileSync(summary, 'utf8'), /### ✅ Dossier Documents absent : jamais recréé/);
  assert.deepEqual(passed.after, passed.before);

  const failed = run('documents-recreated-quietly', { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(failed.code, 1, failed.output);
  const error = failed.output.split('\n').find((line) => line.startsWith('::error title=Dossier Documents absent — '));
  assert.ok(error, failed.output);
  assert.match(error, /Le dossier Documents a été recréé pendant le lancement d'Evolve/);
  assert.match(readFileSync(summary, 'utf8'), /### ❌ Dossier Documents absent : échec/);
  assert.deepEqual(failed.after, failed.before);
});
