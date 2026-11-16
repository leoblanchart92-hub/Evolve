/**
 * Vérification de l'installateur (scripts/check-setup.mjs) et outils communs
 * (scripts/setup-tools.mjs).
 *
 * L'installation réelle n'a lieu que sous Windows, pendant la compilation
 * automatique. Ici sont éprouvées les décisions : ce qu'un relevé de Windows
 * doit contenir après l'installation, et ce qui ne doit plus s'y trouver
 * après la désinstallation.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { parseOptions, REQUIRED_FILES } from '../scripts/check-setup.mjs';
import {
  APP_EXE,
  INSTALLER_COPY_DIR,
  STATE_SCRIPT,
  UNINSTALLER_EXE,
  expectedInstallDir,
  firstLine,
  formatSize,
  installProblems,
  inventory,
  namesIn,
  parseCommandLine,
  parseInstallState,
  profileChanges,
  readInstallState,
  sameWindowsPath,
  uninstallLeftovers,
  uninstallSilently,
  waitFor,
} from '../scripts/setup-tools.mjs';
import { fromRoot, readText } from './helpers.mjs';

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-setup-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const LOCAL = 'C:\\Users\\Léa\\AppData\\Local';
const ROAMING = 'C:\\Users\\Léa\\AppData\\Roaming';
const DIR = `${LOCAL}\\Programs\\Evolve`;
const EXE = `${DIR}\\Evolve.exe`;
const UNINSTALLER = `${DIR}\\Uninstall Evolve.exe`;

/** Relevé d'une machine où Evolve n'est pas installé. */
const absent = (changes = {}) => ({ user: [], machine: [], startMenu: null, desktop: null, run: [], startupLinks: [], localAppData: LOCAL, appData: ROAMING, temp: `${LOCAL}\\Temp\\`, ...changes });

/** Inscription conforme, à la version donnée. */
const entryOf = (version = '0.6.0', changes = {}) => ({
  key: '3b9c5a1e-0f0d-5a0e-8d7e-2f4b1c6a9e10',
  name: `Evolve ${version}`,
  version,
  location: DIR,
  uninstall: `"${UNINSTALLER}" /currentuser`,
  quiet: `"${UNINSTALLER}" /currentuser /S`,
  ...changes,
});

/** Relevé d'une installation conforme. */
const installed = (changes = {}) =>
  absent({
    user: [entryOf()],
    startMenu: { file: `${ROAMING}\\Microsoft\\Windows\\Start Menu\\Programs\\Evolve.lnk`, target: EXE, arguments: '' },
    desktop: { file: 'C:\\Users\\Léa\\Desktop\\Evolve.lnk', target: EXE, arguments: '' },
    ...changes,
  });

test('installation conforme : une seule inscription, pour l’utilisateur seul, deux raccourcis, rien au démarrage', () => {
  assert.deepEqual(installProblems(installed(), { version: '0.6.0' }), []);
  assert.equal(expectedInstallDir(installed()), DIR);
  // Ni la casse du chemin, ni une barre finale ne comptent : Windows ne les distingue pas.
  const relaxed = installed({ user: [entryOf('0.6.0', { location: `${DIR.toUpperCase()}\\` })], startMenu: { file: 'x', target: EXE.toLowerCase(), arguments: '  ' } });
  assert.deepEqual(installProblems(relaxed, { version: '0.6.0' }), []);
});

test('installation : chaque écart est nommé', () => {
  const problemsOf = (changes, version = '0.6.0') => installProblems(installed(changes), { version });

  // Inscrit pour toute la machine : il a fallu des droits d'administrateur.
  assert.match(problemsOf({ machine: [entryOf()] })[0], /inscrit pour toute la machine \(HKLM\).*Evolve 0\.6\.0/);
  // Aucune inscription, ou deux : rien d'autre n'est examiné.
  assert.deepEqual(problemsOf({ user: [] }), ["0 inscription(s) parmi les programmes de l'utilisateur, au lieu d'une seule"]);
  assert.deepEqual(problemsOf({ user: [entryOf(), entryOf('0.5.0')] }), ["2 inscription(s) parmi les programmes de l'utilisateur, au lieu d'une seule"]);
  // Version attendue différente.
  assert.deepEqual(problemsOf({}, '0.7.0'), ['nom inscrit : « Evolve 0.6.0 », au lieu de « Evolve 0.7.0 »', 'version inscrite : 0.6.0, au lieu de 0.7.0']);
  // Installé ailleurs que dans le profil.
  const elsewhere = problemsOf({ user: [entryOf('0.6.0', { location: 'C:\\Program Files\\Evolve' })] });
  assert.ok(elsewhere.some((problem) => problem.startsWith("dossier d'installation inattendu : C:\\Program Files\\Evolve")), elsewhere.join('\n'));
  // Désinstallation inscrite pour tous les utilisateurs, ou sans mode silencieux.
  const all = problemsOf({ user: [entryOf('0.6.0', { uninstall: `"${UNINSTALLER}" /allusers`, quiet: `"${UNINSTALLER}" /allusers` })] });
  assert.ok(all.some((problem) => /^désinstallation : l'option \/currentuser est absente/.test(problem)), all.join('\n'));
  assert.ok(all.some((problem) => /^désinstallation : demandée pour tous les utilisateurs/.test(problem)));
  assert.ok(all.some((problem) => /^désinstallation silencieuse : l'option \/S est absente/.test(problem)));
  const foreign = problemsOf({ user: [entryOf('0.6.0', { quiet: '"C:\\Windows\\System32\\cmd.exe" /currentuser /S' })] });
  assert.deepEqual(foreign, ['désinstallation silencieuse : programme inattendu ("C:\\Windows\\System32\\cmd.exe" /currentuser /S)']);
  const none = problemsOf({ user: [entryOf('0.6.0', { uninstall: '', quiet: '' })] });
  assert.equal(none.length, 5, none.join('\n'));

  // Raccourcis : absents, vers un autre programme, ou avec des arguments.
  assert.deepEqual(problemsOf({ startMenu: null, desktop: null }), ['raccourci du menu Démarrer absent', 'raccourci du bureau absent']);
  assert.deepEqual(problemsOf({ desktop: { file: 'x', target: 'C:\\autre\\Evolve.exe', arguments: '' } }), [`raccourci du bureau : il mène à C:\\autre\\Evolve.exe, au lieu de ${EXE}`]);
  assert.deepEqual(problemsOf({ startMenu: { file: 'x', target: EXE, arguments: '--windowed' } }), ['raccourci du menu Démarrer : arguments inattendus (--windowed)']);

  // Lancement au démarrage de Windows.
  assert.deepEqual(problemsOf({ run: [{ name: 'Evolve', value: `"${EXE}"` }] }), [`lancement au démarrage de Windows (registre) : Evolve = "${EXE}"`]);
  assert.deepEqual(problemsOf({ startupLinks: ['Evolve.lnk'] }), ['lancement au démarrage de Windows (dossier Démarrage) : Evolve.lnk']);
});

test('désinstallation : tout ce qui reste est nommé', () => {
  assert.deepEqual(uninstallLeftovers(absent()), []);
  const left = uninstallLeftovers(installed({ machine: [entryOf('0.5.0')], run: [{ name: 'Evolve', value: 'x' }], startupLinks: ['Evolve.lnk'] }));
  assert.equal(left.length, 6);
  assert.match(left[0], /^inscription « Evolve 0\.6\.0 »/);
  assert.match(left[1], /^inscription « Evolve 0\.5\.0 »/);
  assert.match(left[2], /^raccourci du menu Démarrer \(/);
  assert.match(left[3], /^raccourci du bureau \(/);
  assert.equal(left[4], 'lancement au démarrage (Evolve)');
  assert.equal(left[5], 'raccourci du dossier Démarrage (Evolve.lnk)');
});

test('relevé de Windows : accepté seulement s’il est complet', () => {
  const text = JSON.stringify(installed());
  assert.deepEqual(parseInstallState(text), installed());
  // Marque d'ordre des octets en tête de fichier : ignorée.
  assert.deepEqual(parseInstallState(`\uFEFF${text}`), installed());
  assert.throws(() => parseInstallState('{'), /relevé de l'installation illisible/);
  for (const broken of [
    null,
    [],
    {},
    { ...installed(), user: null },
    { ...installed(), user: [{ name: 'Evolve 0.6.0' }] },
    { ...installed(), machine: 'aucune' },
    { ...installed(), startMenu: 'Evolve.lnk' },
    { ...installed(), desktop: { file: 'x' } },
    { ...installed(), run: null },
    { ...installed(), startupLinks: undefined },
    { ...installed(), localAppData: '' },
    { ...installed(), appData: 42 },
  ]) {
    assert.throws(() => parseInstallState(JSON.stringify(broken)), /relevé de l'installation incomplet/, JSON.stringify(broken));
  }
});

test('relevé de Windows : le script est lancé avec le fichier où écrire, et son échec est rapporté', () => {
  // PowerShell écrit le relevé dans le fichier qui lui est désigné.
  const calls = [];
  const state = readInstallState({
    run: (script, { env }) => {
      calls.push(script);
      writeFileSync(env.EVOLVE_STATE_FILE, JSON.stringify(installed()));
      return { ok: true, detail: '' };
    },
  });
  assert.deepEqual(state, installed());
  assert.deepEqual(calls, [STATE_SCRIPT]);

  assert.throws(() => readInstallState({ run: () => ({ ok: false, detail: 'accès refusé' }) }), /relevé de l'installation impossible : accès refusé/);
  assert.throws(() => readInstallState({ run: () => ({ ok: true, detail: '' }) }), /aucun résultat écrit/);
  assert.throws(
    () =>
      readInstallState({
        run: (_script, { env }) => {
          writeFileSync(env.EVOLVE_STATE_FILE, '{}');
          return { ok: true, detail: '' };
        },
      }),
    /incomplet/,
  );
});

test('script de relevé : il lit, sans rien modifier', () => {
  // Uniquement des lectures : aucune commande qui écrit dans le registre, supprime ou lance un programme.
  assert.doesNotMatch(STATE_SCRIPT, /\b(?:Set-Item|New-Item|Remove-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Start-Process|Invoke-Expression|Invoke-WebRequest|Stop-Process)\b/i);
  // Le seul fichier écrit est celui du relevé, désigné par le script appelant.
  assert.equal([...STATE_SCRIPT.matchAll(/WriteAllText|Out-File|Set-Content|Add-Content/g)].length, 1);
  assert.match(STATE_SCRIPT, /\[System\.IO\.File\]::WriteAllText\(\$env:EVOLVE_STATE_FILE, /);
  // Les trois emplacements où Windows inscrit un programme : utilisateur, machine, machine (programmes 32 bits).
  for (const root of ["'HKCU:\\' + $uninstall", "'HKLM:\\' + $uninstall", "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'"]) {
    assert.ok(STATE_SCRIPT.includes(`Get-Entries (${root})`), root);
  }
  // Écrit dans un littéral : aucun texte n'y est inséré par JavaScript.
  assert.ok(!STATE_SCRIPT.includes('${'));
});

test('chemins et lignes de commande de Windows', () => {
  assert.equal(sameWindowsPath('C:\\Users\\Léa\\Evolve', 'c:\\users\\léa\\evolve\\'), true);
  assert.equal(sameWindowsPath('C:/Users/Léa/Evolve', 'C:\\Users\\Léa\\Evolve'), true);
  assert.equal(sameWindowsPath('C:\\Users\\Léa\\Evolve', 'C:\\Users\\Léa\\Evolve 2'), false);
  for (const empty of ['', null, undefined]) assert.equal(sameWindowsPath(empty, empty), false);

  assert.deepEqual(parseCommandLine(`"${UNINSTALLER}" /currentuser /S`), [UNINSTALLER, '/currentuser', '/S']);
  assert.deepEqual(parseCommandLine('C:\\outil.exe  /S'), ['C:\\outil.exe', '/S']);
  for (const empty of ['', '   ', null, undefined]) assert.deepEqual(parseCommandLine(empty), []);

  assert.equal(firstLine('#< CLIXML\r\n<Objs Version="1.1">\r\n\r\n  Accès refusé.  \r\nsuite'), 'Accès refusé.');
  assert.equal(firstLine(null), '');
  assert.equal(formatSize(312 * 1024 * 1024), '312 Mo');
  assert.equal(formatSize(14 * 1024), '14 Ko');
  assert.equal(formatSize(12), '12 octets');
  assert.equal(formatSize(Number.NaN), 'taille inconnue');
});

test('profil de l’utilisateur : seuls les dossiers qui évoquent Evolve et ne sont pas attendus sont signalés', () => {
  const before = ['Microsoft', 'Packages', 'Temp'];
  // D'autres programmes écrivent dans le profil pendant ce temps : ils ne sont pas comptés.
  assert.deepEqual(profileChanges(before, [...before, 'Programs', 'D3DSCache'], ['Programs']), { created: ['Programs', 'D3DSCache'], unexpected: [] });
  assert.deepEqual(profileChanges(before, [...before, 'evolve-updater', 'Evolve'], ['Evolve']), { created: ['evolve-updater', 'Evolve'], unexpected: ['evolve-updater'] });
  // Un dossier déjà présent, même écrit autrement, n'est pas « apparu ».
  assert.deepEqual(profileChanges(['EVOLVE'], ['Evolve']), { created: [], unexpected: [] });
  assert.deepEqual(profileChanges([], []), { created: [], unexpected: [] });
});

test('inventaire du dossier installé : fichiers comptés, outil d’élévation repéré où qu’il soit', () => {
  const dir = path.join(workDir, 'Evolve');
  mkdirSync(path.join(dir, 'resources', 'app.asar.unpacked'), { recursive: true });
  writeFileSync(path.join(dir, APP_EXE), 'x'.repeat(100));
  writeFileSync(path.join(dir, UNINSTALLER_EXE), 'x'.repeat(10));
  writeFileSync(path.join(dir, 'resources', 'app.asar'), 'x'.repeat(1000));
  assert.deepEqual(inventory(dir, { watch: ['elevate.exe'] }), { files: 3, bytes: 1110, found: [] });
  writeFileSync(path.join(dir, 'resources', 'Elevate.EXE'), 'x');
  assert.deepEqual(inventory(dir, { watch: ['elevate.exe'] }), { files: 4, bytes: 1111, found: [path.join('resources', 'Elevate.EXE')] });
  assert.deepEqual(inventory(path.join(workDir, 'absent')), { files: 0, bytes: 0, found: [] });
  assert.deepEqual(namesIn(dir), ['Evolve.exe', 'Uninstall Evolve.exe', 'resources']);
  assert.deepEqual(namesIn(path.join(workDir, 'absent')), []);
  // Ce que le dossier installé doit contenir : programme, désinstallateur, application, module natif.
  assert.deepEqual(REQUIRED_FILES.map((name) => name.split(path.sep).join('/')), ['Evolve.exe', 'Uninstall Evolve.exe', 'resources/app.asar', 'resources/app.asar.unpacked/native/build/Release/evolve_fs.node']);
  assert.equal(INSTALLER_COPY_DIR, 'evolve-updater');
});

test('attente : rend la valeur dès qu’elle existe, `null` au bout du délai, même si la question échoue', async () => {
  let asked = 0;
  assert.equal(await waitFor(() => ((asked += 1) >= 3 ? 'prêt' : null), { timeout: 2000, interval: 5 }), 'prêt');
  assert.equal(asked, 3);
  assert.equal(await waitFor(() => false, { timeout: 30, interval: 5 }), null);
  assert.equal(await waitFor(() => Promise.reject(new Error('panne')), { timeout: 30, interval: 5 }), null);
  let later = 0;
  assert.equal(
    await waitFor(
      () => {
        later += 1;
        if (later < 2) throw new Error('pas encore');
        return 7;
      },
      { timeout: 2000, interval: 5 },
    ),
    7,
  );
});

test('désinstallation : sans désinstallateur inscrit, rien n’est lancé', async () => {
  const none = await uninstallSilently({ quiet: '', location: DIR });
  assert.deepEqual(none, { ok: false, detail: 'désinstallateur introuvable : (aucune commande inscrite)', state: null });
  const missing = await uninstallSilently({ quiet: `"${path.join(workDir, 'absent', 'Uninstall Evolve.exe')}" /currentuser /S`, location: DIR });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /^désinstallateur introuvable : /);
});

test('options du script', () => {
  const defaults = parseOptions([], { version: '1.2.3' });
  assert.equal(defaults.setup, fromRoot('dist', 'Evolve-Setup-1.2.3.exe'));
  assert.equal(defaults.outDir, fromRoot('self-test-output', 'installation'));
  assert.equal(defaults.selfTest, true);
  assert.equal(defaults.timeoutSeconds, 300);

  const custom = parseOptions(['--out=resultats', path.join(workDir, 'Setup.exe'), '--skip-self-test', '--timeout=42']);
  assert.equal(custom.setup, path.join(workDir, 'Setup.exe'));
  assert.equal(custom.outDir, path.resolve('resultats'));
  assert.equal(custom.selfTest, false);
  assert.equal(custom.timeoutSeconds, 42);
  assert.ok(Number.isNaN(parseOptions(['--timeout=bientôt']).timeoutSeconds));
});

test(
  'hors de Windows, le script refuse de s’exécuter : il installerait réellement Evolve',
  { skip: process.platform === 'win32' ? 'vérification de l’installateur : sous Windows, la compilation automatique installe réellement Evolve' : false },
  () => {
    const result = spawnSync(process.execPath, [fromRoot('scripts', 'check-setup.mjs'), `--out=${path.join(workDir, 'resultats')}`], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /✖ cette vérification installe réellement Evolve : elle ne s'exécute que sous Windows/);
    assert.match(result.stdout, /^::error title=Installation — Evolve-Setup-\d+\.\d+\.\d+\.exe::Installation en échec/m);
  },
);

test('le script laisse la machine telle qu’elle était', () => {
  const script = readText('scripts/check-setup.mjs');
  // Evolve déjà installé : rien n'est lancé.
  assert.match(script, /if \(before\.user\.length > 0 \|\| before\.machine\.length > 0 \|\| existsSync\(installDir\)\) \{\s+fail\(/);
  // La désinstallation a lieu dans tous les cas, y compris après un échec.
  assert.match(script, /\} finally \{\s+\/\/ --- 5\. Désinstallation/);
  // Il ne supprime que son fichier témoin, puis son dossier s'il est vide : jamais un dossier avec son contenu.
  assert.doesNotMatch(script, /recursive: true, force: true|rmSync\([^)]*recursive/);
  assert.equal([...script.matchAll(/\brmSync\(|\brmdirSync\(/g)].length, 2);
});
