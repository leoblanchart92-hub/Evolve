/**
 * Vérification « le programme d'installation installe une application qui
 * fonctionne, puis la désinstalle entièrement » (scripts/check-setup.mjs).
 * Un faux programme d'installation (tests/fixtures/fake-setup.mjs) imite les
 * comportements possibles d'un installateur NSIS : installation complète,
 * installation incomplète, échec, blocage, désinstallation laissée en plan,
 * réglages de l'utilisateur emportés…
 *
 * Ces essais n'installent rien sur la machine : tout se déroule dans un
 * dossier d'essai (options --install-dir, --start-menu, --desktop,
 * --settings-dir) et l'application « installée » est la fausse application
 * (tests/fixtures/fake-app.mjs). Ils produisent de petits scripts exécutables
 * (avec « #! ») : ils tournent sous Linux et macOS, et sont ignorés sous
 * Windows — où ce script est de toute façon éprouvé pour de vrai, sur le
 * véritable installateur, par la compilation.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { fromRoot, readText } from './helpers.mjs';

const SCRIPT = fromRoot('scripts', 'check-setup.mjs');
const FAKE_SETUP = fromRoot('tests', 'fixtures', 'fake-setup.mjs');
const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-check-setup-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Essais ignorés sous Windows : la fausse application y est un script « #! ». */
const options = process.platform === 'win32' ? { skip: 'faux exécutable sous forme de script : essais menés sous Linux et macOS' } : {};

let sequence = 0;

/**
 * Lance le script contre le faux programme d'installation, dans un dossier
 * d'essai neuf.
 * @param {string} mode              mode du faux programme d'installation
 * @param {object} [settings]
 * @param {string[]} [settings.flags]  options transmises au faux programme
 * @param {string[]} [settings.script] options transmises au script de vérification
 * @param {boolean} [settings.settings]  créer un dossier de réglages avant la vérification
 * @param {boolean} [settings.installed] créer le dossier d'installation avant la vérification
 * @param {object} [settings.env]        variables d'environnement supplémentaires
 * @param {number} [settings.timeout]    délai transmis au script, en secondes
 */
function run(mode, { flags = [], script = [], settings = true, installed = false, env = {}, timeout = 20 } = {}) {
  const base = path.join(workDir, `essai-${(sequence += 1)}`);
  const parent = path.join(base, 'Programs');
  const installDir = path.join(parent, 'Evolve');
  const startMenu = path.join(base, 'Menu Demarrer');
  const desktopDir = path.join(base, 'Bureau');
  const settingsDir = path.join(base, 'Reglages');
  const outDir = path.join(base, 'resultats');
  for (const dir of [parent, startMenu, desktopDir]) mkdirSync(dir, { recursive: true });
  if (settings) {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(path.join(settingsDir, 'settings.json'), '{}\n', 'utf8');
  }
  if (installed) mkdirSync(path.join(installDir, 'resources'), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const setup = [mode, `--install-dir=${installDir}`, `--start-menu=${startMenu}`, `--desktop=${desktopDir}`, `--settings-dir=${settingsDir}`, ...flags];
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      process.execPath,
      `--install-dir=${installDir}`,
      `--start-menu=${startMenu}`,
      `--desktop=${desktopDir}`,
      `--settings-dir=${settingsDir}`,
      `--out=${outDir}`,
      `--timeout=${timeout}`,
      ...script,
      '--',
      FAKE_SETUP,
      ...setup,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '', ...env },
      timeout: 120_000,
    },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {
    code: result.status,
    output,
    parent,
    installDir,
    startMenu,
    desktopDir,
    settingsDir,
    outDir,
    /** Contenu d’un dossier de l’essai, ou `null` s’il n’existe pas. */
    listing: (dir) => (existsSync(dir) ? readdirSync(dir).sort() : null),
  };
}

// L'application installée doit être un vrai exécutable : la vérification est
// menée pour de vrai sur la machine de compilation, sous Windows.
before(() => {
  assert.match(readText('scripts', 'check-setup.mjs'), /const EXE = 'Evolve\.exe';/);
});

test('réussite : installation complète, auto-test de l’application installée, désinstallation complète', options, () => {
  const { code, output, parent, installDir, startMenu, desktopDir, settingsDir, outDir } = run('install');
  assert.equal(code, 0, output);
  assert.match(output, /── 1\. Installation silencieuse, sans aucune fenêtre ──/);
  assert.match(output, /✔ installé dans .*Evolve \(5 fichiers\)/);
  assert.match(output, /✔ Evolve\.exe est en place/);
  assert.match(output, /✔ Uninstall Evolve\.exe est en place/);
  assert.match(output, /✔ raccourci dans le menu Démarrer/);
  assert.match(output, /✔ raccourci dans le bureau/);
  assert.match(output, /── 4\. Auto-test de l’application installée ──/);
  assert.match(output, /✔ l’application installée démarre et contrôle son interface sans erreur/);
  assert.match(output, /✔ plus rien dans .*Evolve/);
  assert.match(output, /✔ raccourcis retirés du menu Démarrer et du bureau/);
  assert.match(output, /✔ .*Programs est revenu à son état initial \(0 élément\)/);
  assert.match(output, /✔ les réglages de l’utilisateur sont intacts \(1 élément\)/);
  assert.match(output, /✔ Installation et désinstallation : conformes/);
  assert.doesNotMatch(output, /✖/);

  // Rien ne subsiste : ni application, ni raccourci, et les réglages sont là.
  assert.equal(existsSync(installDir), false);
  assert.deepEqual(readdirSync(parent), []);
  assert.deepEqual(readdirSync(startMenu), []);
  assert.deepEqual(readdirSync(desktopDir), []);
  assert.deepEqual(readdirSync(settingsDir), ['settings.json']);
  assert.equal(readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'), '{}\n');
  // Le rapport de l'application installée est conservé avec les résultats.
  assert.equal(JSON.parse(readFileSync(path.join(outDir, 'result.json'), 'utf8')).ok, true);
});

test('installation refusée : programme en erreur, ou installation introuvable', options, () => {
  const failed = run('fails');
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /✖ Le programme d’installation s’est terminé en erreur \(code 2\) : installation refusée\./);
  assert.match(failed.output, /ne doit pas être distribué/);
  assert.equal(existsSync(failed.installDir), false, 'rien à nettoyer');

  const nothing = run('nothing');
  assert.equal(nothing.code, 1, nothing.output);
  assert.match(nothing.output, /✖ Le programme d’installation s’est terminé sans erreur, mais .*Evolve n’existe pas : rien n’a été installé\./);
});

test('installation incomplète : application, désinstallateur, raccourcis ou contenu manquants', options, () => {
  for (const [flag, message, script] of [
    ['--no-exe', /✖ L’application installée est introuvable/, null],
    ['--no-uninstaller', /✖ Le désinstallateur est introuvable/, null],
    ['--no-start-menu', /✖ Aucun raccourci « Evolve\.lnk » dans le menu Démarrer/, null],
    ['--no-desktop', /✖ Aucun raccourci « Evolve\.lnk » dans le bureau/, null],
    ['--few-files', /✖ L’installation ne contient que 2 fichier\(s\) : elle est manifestement incomplète/, null],
    [null, /✖ L’application installée n’a pas passé l’auto-test/, ['--keep']],
  ]) {
    // « --app=fail » fait échouer l'auto-test de l'application installée.
    const flags = flag === null ? ['--app=fail'] : [flag];
    const { code, output, installDir, startMenu, desktopDir } = run('install', { flags, script: script ? [script] : [] });
    assert.equal(code, 1, `${flag ?? script}\n${output}`);
    assert.match(output, message, String(flag));
    assert.match(output, /ne doit pas être distribué/);
    if (!script) {
      // L'installation fautive est retirée : une vérification suivante peut repartir de zéro.
      assert.equal(existsSync(installDir), false, String(flag));
      if (flag !== '--no-start-menu') assert.deepEqual(readdirSync(startMenu), [], String(flag));
      if (flag !== '--no-desktop') assert.deepEqual(readdirSync(desktopDir), [], String(flag));
    }
  }
});

test('application installée qui ne fonctionne pas : la vérification échoue, même si l’installation est complète', options, () => {
  const { code, output, installDir } = run('install', { flags: ['--app=fail'] });
  assert.equal(code, 1, output);
  assert.match(output, /✔ raccourci dans le bureau/);
  assert.match(output, /✖ L’application installée n’a pas passé l’auto-test : .*Evolve\.exe/);
  assert.match(output, /Une application installée doit fonctionner comme l’exécutable portable/);
  // --keep n'étant pas demandé, l'application fautive est retirée.
  assert.equal(existsSync(installDir), false);
});

test('désinstallation laissée en plan : il reste des fichiers, ou le dossier', options, () => {
  const files = run('install', { flags: ['--leaves-files'] });
  assert.equal(files.code, 1, files.output);
  assert.match(files.output, /✖ La désinstallation n’a pas tout retiré :\n  le dossier d’installation est toujours là/);
  assert.match(files.output, /Une désinstallation doit laisser l’ordinateur comme elle l’a trouvé/);

  const folder = run('install', { flags: ['--leaves-folder'] });
  assert.equal(folder.code, 1, folder.output);
  assert.match(folder.output, /✖ La désinstallation n’a pas tout retiré :\n  le dossier d’installation est toujours là \(0 élément\)/);
  assert.deepEqual(readdirSync(folder.startMenu), []);
  assert.deepEqual(readdirSync(folder.desktopDir), []);
});

test('réglages de l’utilisateur emportés par la désinstallation : refusé', options, () => {
  const { code, output, settingsDir } = run('install', { flags: ['--remove-settings'] });
  assert.equal(code, 1, output);
  assert.match(output, /✖ Le dossier des réglages a été modifié par la désinstallation/);
  assert.match(output, /Vos réglages doivent survivre à une désinstallation\./);
  assert.equal(existsSync(settingsDir), false);
});

test('désinstallateur en échec, ou qui ne se termine pas', options, () => {
  const failed = run('install', { flags: ['--fail-uninstall'] });
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /✖ Le désinstallateur s’est terminé en erreur \(code 2\)\./);
  assert.equal(existsSync(failed.installDir), false, 'installation retirée malgré tout');

  const hung = run('install', { flags: ['--hang-uninstall'], timeout: 3 });
  assert.equal(hung.code, 1, hung.output);
  assert.match(hung.output, /✖ Le désinstallateur ne s’est pas terminé en 3 s : il a été arrêté\./);
  assert.match(hung.output, /la vérification n’a pas pu avoir lieu/);
  assert.equal(existsSync(hung.installDir), false);
});

test('programme d’installation qui ne se termine pas : abandonné, et ce qu’il avait installé est retiré', options, () => {
  const { code, output, installDir } = run('hang', { timeout: 3 });
  assert.equal(code, 1, output);
  assert.match(output, /✖ Le programme d’installation ne s’est pas terminé en 3 s : il a été arrêté — ce qu’il avait déjà installé va être retiré\./);
  assert.match(output, /la vérification n’a pas pu avoir lieu/);
  assert.doesNotMatch(output, /ne doit pas être distribué/);
  assert.equal(existsSync(installDir), false);
});

test('situations refusées avant toute installation : application déjà installée, programme introuvable', options, () => {
  const installed = run('install', { installed: true });
  assert.equal(installed.code, 1, installed.output);
  assert.match(installed.output, /✖ .*Evolve existe déjà : une installation est déjà en place, ou une vérification précédente a été interrompue\./);
  assert.match(installed.output, /Désinstallez Evolve \(Paramètres Windows → Applications\)/);
  assert.equal(existsSync(path.join(installed.installDir, 'resources')), true, 'rien n’est touché');

  const missing = spawnSync(
    process.execPath,
    [SCRIPT, path.join(workDir, 'introuvable.exe'), '--install-dir=a', '--start-menu=b', '--desktop=c', '--settings-dir=d'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } },
  );
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(`${missing.stdout}\n${missing.stderr}`, /✖ Programme d’installation introuvable : .*introuvable\.exe\n  Fabriquez-le d’abord avec « npm run build:win »\./);
});

test('option --keep : l’application reste en place, la désinstallation n’est pas éprouvée', options, () => {
  const { code, output, installDir, startMenu, desktopDir } = run('install', { script: ['--keep'] });
  assert.equal(code, 0, output);
  assert.match(output, /! option --keep : l’application reste installée, la désinstallation n’est pas éprouvée/);
  assert.match(output, /✔ Installation : application en place et fonctionnelle/);
  assert.doesNotMatch(output, /── 5\. Désinstallation silencieuse ──/);
  assert.equal(existsSync(path.join(installDir, 'Evolve.exe')), true);
  assert.deepEqual(readdirSync(startMenu), ['Evolve.lnk']);
  assert.deepEqual(readdirSync(desktopDir), ['Evolve.lnk']);
});

test('hors Windows, les quatre emplacements doivent être donnés : sans eux, la vérification refuse', () => {
  if (process.platform === 'win32') return; // les emplacements y ont une valeur par défaut
  const result = spawnSync(process.execPath, [SCRIPT, process.execPath, '--out=x', '--', FAKE_SETUP, 'install'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /elle a besoin de connaître les quatre emplacements à surveiller/);
  assert.match(`${result.stdout}\n${result.stderr}`, /--install-dir=DOSSIER --start-menu=DOSSIER --desktop=DOSSIER --settings-dir=DOSSIER/);
});

test('compilation GitHub Actions : le constat est annoncé par une annotation et dans le résumé', options, () => {
  const summary = path.join(workDir, 'resume.md');
  const passed = run('install', { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(passed.code, 0, passed.output);
  const notice = passed.output.split('\n').find((line) => line.startsWith('::notice title=Installation et désinstallation — '));
  assert.ok(notice, passed.output);
  assert.match(notice, /::Installation et désinstallation : conformes%0A✔ installation silencieuse réussie/);
  assert.match(notice, /sans demander l’élévation à Windows/);
  assert.match(readFileSync(summary, 'utf8'), /### ✅ Installation et désinstallation/);

  const failed = run('install', { flags: ['--leaves-files'], env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(failed.code, 1, failed.output);
  const error = failed.output.split('\n').find((line) => line.startsWith('::error title=Installation et désinstallation — '));
  assert.ok(error, failed.output);
  assert.match(error, /La désinstallation n’a pas tout retiré/);
  assert.match(readFileSync(summary, 'utf8'), /### ❌ Installation et désinstallation — .* : échec/);
});
