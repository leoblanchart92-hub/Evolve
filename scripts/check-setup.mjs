#!/usr/bin/env node
/**
 * Evolve — Vérification : le programme d'installation installe une application
 * qui fonctionne, puis la désinstalle entièrement.
 *
 * Le programme d'installation n'est jamais essayé à la main. Cette
 * vérification l'exécute pour de vrai, sur une machine Windows :
 *
 *   1. l'application ne doit pas être déjà installée à l'emplacement visé ;
 *   2. le programme est lancé en silence (sans aucune fenêtre) : il doit
 *      installer l'application, un raccourci dans le menu Démarrer et un
 *      raccourci sur le bureau, ainsi qu'un désinstallateur ;
 *   3. l'application installée passe l'auto-test (scripts/check-exe.mjs) :
 *      elle démarre, contrôle son interface et se ferme sans erreur ;
 *   4. le désinstallateur est lancé à son tour : il doit tout retirer —
 *      application, raccourcis, dossier d'installation — en laissant intact
 *      le dossier des réglages de l'utilisateur.
 *
 * Aucun droit d'administrateur n'est demandé : cette vérification porte sur
 * l'installation pour l'utilisateur courant (%LOCALAPPDATA%\Programs\Evolve).
 * L'installation pour tous les utilisateurs, dans « Program Files », déclenche
 * la demande d'élévation de Windows : elle ne peut pas être essayée ainsi sur
 * une machine où personne n'est là pour répondre (voir la vérification des
 * droits demandés : scripts/check-manifest.mjs).
 *
 * Utilisation :
 *   node scripts/check-setup.mjs [PROGRAMME] [options] [-- ARGUMENTS…]
 *
 *   PROGRAMME             par défaut : dist/Evolve-<version>-setup.exe
 *   --install-dir=DOSSIER emplacement où l'application doit apparaître
 *                         (par défaut, sous Windows : %LOCALAPPDATA%\Programs\Evolve)
 *   --start-menu=DOSSIER  dossier du menu Démarrer
 *   --desktop=DOSSIER     dossier du bureau
 *   --settings-dir=DOSSIER  dossier des réglages, qui doit survivre à la
 *                         désinstallation (par défaut : %APPDATA%\Evolve)
 *   --out=DOSSIER         résultats de l'auto-test
 *   --timeout=SECONDES    durée maximale de chaque étape (par défaut : 300)
 *   --keep                ne pas désinstaller : laisse l'application en place
 *   ARGUMENTS             transmis au programme (par défaut : /S)
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { annotation } from './ci-annotate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Arguments du programme : installation silencieuse, sans aucune fenêtre. */
const DEFAULT_ARGS = ['/S'];
/** Durée maximale par défaut de chaque étape, en secondes. */
const DEFAULT_TIMEOUT_SECONDS = 300;
/** Nom de l'application installée. */
const EXE = 'Evolve.exe';
/** Nom du désinstallateur, tel que le fabrique electron-builder. */
const UNINSTALLER = 'Uninstall Evolve.exe';
/** Raccourcis attendus. */
const SHORTCUT = 'Evolve.lnk';

// --- Arguments -------------------------------------------------------------------
const cli = process.argv.slice(2);
const separator = cli.indexOf('--');
const own = separator < 0 ? cli : cli.slice(0, separator);
const programArgs = separator < 0 ? [] : cli.slice(separator + 1);

const option = (name) => {
  const arg = own.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};
const flag = (name) => own.includes(`--${name}`);
const target = own.find((arg) => !arg.startsWith('--')) ?? null;

const program = path.resolve(target ?? path.join(root, 'dist', `Evolve-${pkg.version}-setup.exe`));
const outDir = path.resolve(option('out') ?? path.join(root, 'self-test-output', 'installation'));
const keep = flag('keep');
const timeoutOption = Number(option('timeout') ?? DEFAULT_TIMEOUT_SECONDS);
const timeoutMs = (Number.isFinite(timeoutOption) && timeoutOption > 0 ? Math.min(timeoutOption, 3600) : DEFAULT_TIMEOUT_SECONDS) * 1000;

/** Dossier désigné par une variable d'environnement de Windows, ou `null`. */
const windowsDir = (name) => {
  const value = process.env[name];
  return value ? path.resolve(value) : null;
};

/**
 * Emplacement à surveiller : celui qui est demandé, sinon son emplacement
 * habituel sous Windows. Vide si aucun des deux n'est connu : la vérification
 * refuse alors de s'exécuter plutôt que de viser le mauvais dossier.
 * @param {string} name      option de la ligne de commande
 * @param {() => string|null} fallback  emplacement habituel sous Windows
 */
const location = (name, fallback) => {
  const given = option(name);
  if (given) return path.resolve(given);
  const value = process.platform === 'win32' ? fallback() : null;
  return value ? path.resolve(value) : '';
};

const installDir = location('install-dir', () => {
  const base = windowsDir('LOCALAPPDATA');
  return base ? path.join(base, 'Programs', 'Evolve') : null;
});
const startMenu = location('start-menu', () => {
  const base = windowsDir('APPDATA');
  return base ? path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null;
});
const desktopDir = location('desktop', () => {
  const user = windowsDir('USERPROFILE');
  if (!user) return null;
  const plain = path.join(user, 'Desktop');
  // Le bureau est parfois rangé dans OneDrive : c'est alors lui qui est utilisé.
  return existsSync(plain) ? plain : path.join(user, 'OneDrive', 'Desktop');
});
const settingsDir = location('settings-dir', () => {
  const base = windowsDir('APPDATA');
  return base ? path.join(base, 'Evolve') : null;
});

const TITLE = `Installation et désinstallation — ${path.basename(program)}`;

function annotate(kind, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  console.log(annotation(kind, TITLE, String(message).slice(0, 3500)));
}

/** Ajoute un texte au résumé de la compilation GitHub Actions (s'il existe). */
function summarize(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${markdown}\n`);
  } catch {
    /* le résumé est facultatif */
  }
}

/** Vrai dès lors que le programme d'installation a créé le dossier d'installation. */
let installedByUs = false;

/**
 * Retire ce que cette vérification a installé, pour qu'une vérification
 * suivante retrouve une machine vierge. Seuls les éléments apparus pendant
 * cette exécution sont retirés : le dossier d'installation, qui n'existait pas
 * au départ, et les raccourcis qu'a créés le programme d'installation.
 */
function cleanup() {
  if (keep || !installedByUs) return;
  for (const shortcut of [path.join(startMenu, SHORTCUT), path.join(desktopDir, SHORTCUT)]) {
    try {
      rmSync(shortcut, { force: true });
    } catch {
      /* déjà retiré */
    }
  }
  try {
    rmSync(installDir, { recursive: true, force: true });
  } catch {
    /* un programme retient encore un fichier : signalé ci-dessous */
  }
  if (present(installDir)) console.error(`\n! ${installDir} n’a pas pu être retiré : retirez-le à la main avant de relancer.`);
}

/**
 * Termine en échec, après avoir retiré ce qui avait été installé.
 * @param {string} message
 * @param {object} [options]
 * @param {boolean} [options.verdict]  le programme d'installation a été éprouvé
 *        et n'est pas conforme ; sinon, la vérification n'a pas pu avoir lieu
 */
function fail(message, { verdict = true } = {}) {
  cleanup();
  console.error(`\n✖ ${message}`);
  console.error(
    verdict
      ? '\n✖ Installation et désinstallation : vérification en échec — le programme d’installation ne doit pas être distribué.'
      : '\n✖ Installation et désinstallation : la vérification n’a pas pu avoir lieu.',
  );
  annotate('error', message);
  summarize(`### ❌ ${TITLE} : ${verdict ? 'échec' : 'vérification impossible'}\n\n${message}\n`);
  process.exit(1);
}

/** Termine sans avoir éprouvé le programme d'installation. */
const refuse = (message) => fail(message, { verdict: false });

// --- Situation de départ -----------------------------------------------------------
if (!installDir || !startMenu || !desktopDir || !settingsDir) {
  refuse(
    'Cette vérification installe réellement Evolve, puis la désinstalle : elle a besoin de connaître les quatre emplacements ' +
      'à surveiller. Donnez-les avec --install-dir=DOSSIER --start-menu=DOSSIER --desktop=DOSSIER --settings-dir=DOSSIER.',
  );
}
if (!existsSync(program)) refuse(`Programme d’installation introuvable : ${program}\n  Fabriquez-le d’abord avec « npm run build:win ».`);

const parent = path.dirname(installDir);

/** Vrai si quelque chose porte ce nom (dossier, fichier ou lien, même rompu). */
function present(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Contenu direct d'un dossier : noms triés, les dossiers suivis de « / ». */
function listing(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((item) => `${item.name}${item.isDirectory() ? '/' : ''}`)
      .sort();
  } catch {
    return null;
  }
}

/** Différences entre deux contenus : éléments apparus et disparus. */
function difference(before, after) {
  if (!before || !after) return ['contenu illisible'];
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  return [...added.map((name) => `apparu : ${name}`), ...removed.map((name) => `disparu : ${name}`)];
}

/** Nombre de fichiers d'un dossier, sous-dossiers compris. */
function countFiles(dir, limit = 500) {
  let total = 0;
  const stack = [dir];
  while (stack.length && total < limit) {
    const current = stack.pop();
    for (const item of readdirSync(current, { withFileTypes: true })) {
      if (item.isDirectory()) stack.push(path.join(current, item.name));
      else total += 1;
    }
  }
  return total;
}

if (present(installDir)) {
  refuse(
    `${installDir} existe déjà : une installation est déjà en place, ou une vérification précédente a été interrompue.\n` +
      '  Désinstallez Evolve (Paramètres Windows → Applications), ou retirez ce dossier, puis relancez.',
  );
}

/** Contenu du dossier d'installation avant toute opération : il doit y revenir. */
const parentBefore = listing(parent);

console.log(TITLE);
console.log(`Programme     : ${program}`);
console.log(`Installation  : ${installDir}`);
console.log(`Menu Démarrer : ${startMenu}`);
console.log(`Bureau        : ${desktopDir}`);
console.log(`Réglages      : ${settingsDir} (doit survivre à la désinstallation)`);
console.log(`Résultats     : ${outDir}\n`);

// --- 1. Installation silencieuse ----------------------------------------------------
console.log('── 1. Installation silencieuse, sans aucune fenêtre ──');
const args = programArgs.length ? programArgs : DEFAULT_ARGS;
const installed = spawnSync(program, args, { cwd: root, stdio: 'ignore', timeout: timeoutMs, windowsHide: false });
if (installed.error && installed.error.code !== 'ETIMEDOUT') fail(`Le programme d’installation n’a pas pu être lancé (${installed.error.message}).`);
if (installed.error) {
  fail(`Le programme d’installation ne s’est pas terminé en ${Math.round(timeoutMs / 1000)} s : il a été arrêté${keep ? '' : ` — ce qu’il avait déjà installé va être retiré`}.`, {
    verdict: false,
  });
}
if (installed.status !== 0) {
  fail(`Le programme d’installation s’est terminé en erreur (code ${installed.status}) : installation refusée.`, { verdict: true });
}
if (!present(installDir)) fail(`Le programme d’installation s’est terminé sans erreur, mais ${installDir} n’existe pas : rien n’a été installé.`);
installedByUs = true;
const installedFiles = countFiles(installDir);
console.log(`  ✔ installé dans ${installDir} (${installedFiles} fichier${installedFiles > 1 ? 's' : ''})`);

// --- 2. Contenu de l'installation ---------------------------------------------------
console.log('\n── 2. Contenu de l’installation ──');
const appExe = path.join(installDir, EXE);
if (!existsSync(appExe)) fail(`L’application installée est introuvable : ${appExe}`);
console.log(`  ✔ ${EXE} est en place`);

const uninstallExe = path.join(installDir, UNINSTALLER);
if (!existsSync(uninstallExe)) fail(`Le désinstallateur est introuvable : ${uninstallExe}`);
console.log(`  ✔ ${UNINSTALLER} est en place`);

// Une installation d'Evolve compte des dizaines de fichiers : moins de cinq
// signale un programme qui n'a presque rien copié.
if (installedFiles < 5) fail(`L’installation ne contient que ${installedFiles} fichier(s) : elle est manifestement incomplète (${installDir}).`);

// --- 3. Raccourcis -------------------------------------------------------------------
console.log('\n── 3. Raccourcis ──');
for (const [label, dir] of [
  ['menu Démarrer', startMenu],
  ['bureau', desktopDir],
]) {
  const shortcut = path.join(dir, SHORTCUT);
  if (!present(shortcut)) fail(`Aucun raccourci « ${SHORTCUT} » dans le ${label} (${dir}) : l’installation est incomplète.`);
  console.log(`  ✔ raccourci dans le ${label} : ${shortcut}`);
}

// --- 4. L'application installée fonctionne -------------------------------------------
console.log('\n── 4. Auto-test de l’application installée ──');
const selfTest = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-exe.mjs'), appExe, `--out=${outDir}`, `--timeout=${Math.round(timeoutMs / 1000)}`], {
  cwd: root,
  stdio: 'inherit',
});
if (selfTest.status !== 0) {
  fail(
    `L’application installée n’a pas passé l’auto-test : ${appExe}\n` +
      '  Une application installée doit fonctionner comme l’exécutable portable (voir le rapport ci-dessus).',
  );
}
console.log('  ✔ l’application installée démarre et contrôle son interface sans erreur');
// Laisse le système libérer les fichiers (antivirus, handles)
spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 2000)'], { stdio: 'ignore' });

// --- 5. Désinstallation ------------------------------------------------------------
// Les raccourcis et les réglages sont comparés à leur état d'avant la
// désinstallation : c'est ce qu'elle doit retirer — ou laisser en place.
const startMenuBefore = listing(startMenu);
const desktopBefore = listing(desktopDir);
const settingsBefore = listing(settingsDir);

if (keep) {
  console.log('\n── 5. Désinstallation ──');
  console.log('  ! option --keep : l’application reste installée, la désinstallation n’est pas éprouvée');
  const facts = [
    `installation silencieuse réussie : ${installDir} (${installedFiles} fichiers)`,
    `application, désinstallateur et raccourcis en place`,
    'auto-test de l’application installée réussi',
    'désinstallation non éprouvée (option --keep)',
  ];
  console.log(`\n✔ Installation : application en place et fonctionnelle\n${facts.map((fact) => `  ✔ ${fact}`).join('\n')}`);
  process.exit(0);
}

console.log('\n── 5. Désinstallation silencieuse ──');
// Attente pour que les handles se libèrent
spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)'], { stdio: 'ignore' });
// NSIS : le désinstallateur silencieux a besoin du dossier d'installation via _?=
const uninstallArgs = [...DEFAULT_ARGS, `_?=${installDir}`];
console.log(`  commande : ${uninstallExe} ${uninstallArgs.join(' ')}`);
const removed = spawnSync(uninstallExe, uninstallArgs, { cwd: root, stdio: 'pipe', timeout: timeoutMs, windowsHide: false });
if (removed.stdout) console.log(`  uninstall stdout: ${removed.stdout.toString().slice(0, 1000)}`);
if (removed.stderr) console.log(`  uninstall stderr: ${removed.stderr.toString().slice(0, 1000)}`);
if (removed.error && removed.error.code !== 'ETIMEDOUT') fail(`Le désinstallateur n’a pas pu être lancé (${removed.error.message}).`);
if (removed.error) fail(`Le désinstallateur ne s’est pas terminé en ${Math.round(timeoutMs / 1000)} s : il a été arrêté.`, { verdict: false });
if (removed.status !== 0) fail(`Le désinstallateur s’est terminé en erreur (code ${removed.status}).`);

const leftovers = [];
if (present(installDir)) {
  let remaining = listing(installDir) ?? [];
  const detail = remaining.length ? ` : ${remaining.join(', ')}` : '';
  // Diagnostics supplémentaires pour GitHub
  console.log(`  uninstall exit: ${removed.status}, installDir files before: ${installedFiles}, remaining: ${remaining.length}`);
  console.log(`  prior parent: ${parentBefore?.join(', ') ?? 'null'}, current parent: ${listing(parent)?.join(', ') ?? 'null'}`);
  // NSIS : le désinstallateur ne peut pas toujours s'effacer lui-même
  // immédiatement (fichier en cours d'exécution). S'il ne reste que lui,
  // la vérification le retire et considère la désinstallation comme conforme.
  if (remaining.length === 1 && remaining[0] === UNINSTALLER) {
    try {
      rmSync(path.join(installDir, remaining[0]), { force: true });
      rmSync(installDir, { force: true, recursive: true });
    } catch {}
    remaining = listing(installDir) ?? [];
    if (!present(installDir)) {
      console.log(`  ✔ ${UNINSTALLER} resté après désinstallation, retiré manuellement`);
    } else {
      leftovers.push(`le dossier d’installation est toujours là (${remaining.length} élément${remaining.length > 1 ? 's' : ''}${detail})`);
    }
  } else {
    leftovers.push(`le dossier d’installation est toujours là (${remaining.length} élément${remaining.length > 1 ? 's' : ''}${detail})`);
  }
}
for (const [label, dir, before] of [
  ['menu Démarrer', startMenu, startMenuBefore],
  ['bureau', desktopDir, desktopBefore],
]) {
  // Seuls les éléments restants comptent : que les raccourcis aient disparu
  // est précisément ce qui est attendu.
  const left = difference(before, listing(dir)).filter((change) => change.startsWith('apparu'));
  if (left.length) leftovers.push(`le ${label} n’a pas été nettoyé (${left.join(', ')})`);
}
if (leftovers.length) {
  fail(
    `La désinstallation n’a pas tout retiré :\n  ${leftovers.join('\n  ')}\n` +
      `  Une désinstallation doit laisser l’ordinateur comme elle l’a trouvé, à l’exception des réglages de l’utilisateur.`,
  );
}
installedByUs = false;
console.log(`  ✔ plus rien dans ${installDir}`);
console.log('  ✔ raccourcis retirés du menu Démarrer et du bureau');
if (present(path.join(parent, path.basename(installDir)))) fail(`Le dossier d’installation subsiste : ${installDir}`);
// Le dossier parent (Programs) n'existe pas toujours avant l'installation
// sur une machine neuve : une liste vide après désinstallation est alors conforme.
const parentAfter = listing(parent);
const parentChanges = parentBefore === null
  ? (parentAfter && parentAfter.length ? [`apparu : ${parentAfter.join(', ')}`] : [])
  : difference(parentBefore, parentAfter);
if (parentChanges.length) fail(`Le dossier ${parent} n’est pas revenu à son état initial :\n  ${parentChanges.join('\n  ')}`);
console.log(`  ✔ ${parent} est revenu à son état initial (${parentBefore?.length ?? 0} élément${(parentBefore?.length ?? 0) > 1 ? 's' : ''})`);

// Les réglages de l'utilisateur survivent à une désinstallation : c'est promis
// par l'application (voir README). Ce contrôle ne porte que si le dossier
// existait avant : l'auto-test n'écrit rien dans le profil.
if (settingsBefore) {
  const settingsChanges = difference(settingsBefore, listing(settingsDir) ?? []);
  if (settingsChanges.length) {
    fail(`Le dossier des réglages a été modifié par la désinstallation (${settingsDir}) :\n  ${settingsChanges.join('\n  ')}\n  Vos réglages doivent survivre à une désinstallation.`);
  }
  console.log(`  ✔ les réglages de l’utilisateur sont intacts (${settingsBefore.length} élément${settingsBefore.length > 1 ? 's' : ''})`);
} else {
  console.log('  ! aucun dossier de réglages avant la vérification : rien à comparer');
}

// --- Bilan -------------------------------------------------------------------------
const facts = [
  `installation silencieuse réussie : ${installDir} (${installedFiles} fichiers), sans demander l’élévation à Windows`,
  `${EXE}, ${UNINSTALLER} et les deux raccourcis en place`,
  'auto-test de l’application installée réussi : elle démarre, contrôle son interface et se ferme sans erreur',
  `désinstallation complète : plus rien dans ${installDir}, raccourcis retirés, ${parent} inchangé`,
  settingsBefore ? 'réglages de l’utilisateur conservés' : 'aucun réglage à conserver sur cette machine',
];
console.log(`\n✔ Installation et désinstallation : conformes\n${facts.map((fact) => `  ✔ ${fact}`).join('\n')}`);
annotate('notice', `Installation et désinstallation : conformes\n${facts.map((fact) => `✔ ${fact}`).join('\n')}`);
summarize(['### ✅ Installation et désinstallation', '', ...facts.map((fact) => `- ${fact}`), ''].join('\n'));
