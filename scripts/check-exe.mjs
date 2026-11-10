#!/usr/bin/env node
/**
 * Evolve — Vérification de l'exécutable.
 *
 * Lance l'application avec l'option `--self-test` : elle démarre, contrôle
 * elle-même son interface (voir src/main/selftest.js), enregistre un rapport
 * et des captures d'écran dans `self-test-output/`, puis se ferme.
 * Ce script affiche le rapport et se termine en erreur au moindre problème.
 *
 * Utilisation :
 *   node scripts/check-exe.mjs [EXÉCUTABLE] [--timeout=SECONDES] [-- ARGUMENTS…]
 *
 *   EXÉCUTABLE   par défaut : dist/Evolve-<version>-portable.exe ; le mot
 *                « electron » désigne le moteur installé par « npm install »
 *   --out=DOSSIER  dossier des résultats (par défaut : self-test-output/)
 *   ARGUMENTS    placés avant `--self-test`
 *
 * Exemples :
 *   npm run check:exe     vérifie l'exécutable produit par « npm run build:win »
 *   npm run check:dev     vérifie la version de développement (electron .)
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { annotation } from './ci-annotate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// --- Arguments -------------------------------------------------------------------
const cli = process.argv.slice(2);
const separator = cli.indexOf('--');
const own = separator < 0 ? cli : cli.slice(0, separator);
const extraArgs = separator < 0 ? [] : cli.slice(separator + 1);

const timeoutOption = own.find((arg) => arg.startsWith('--timeout='));
const outOption = own.find((arg) => arg.startsWith('--out='));
const target = own.find((arg) => !arg.startsWith('--'));

const timeoutSeconds = timeoutOption ? Number(timeoutOption.slice('--timeout='.length)) : 300;
const exe = resolveExecutable(target);
const outDir = path.resolve(outOption ? outOption.slice('--out='.length) : path.join(root, 'self-test-output'));
const resultFile = path.join(outDir, 'result.json');
/** Erreur fatale du processus principal, consignée par l'application elle-même. */
const fatalFile = path.join(outDir, 'fatal-error.log');

/** Chemin de l'exécutable à vérifier. */
function resolveExecutable(name) {
  if (name === 'electron') {
    try {
      // Le paquet « electron » exporte le chemin de son programme.
      return createRequire(import.meta.url)('electron');
    } catch {
      return path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    }
  }
  return path.resolve(name ?? path.join(root, 'dist', `Evolve-${pkg.version}-portable.exe`));
}

/**
 * Annotation sur la page de l'exécution GitHub Actions : le résultat de
 * l'auto-test y est lisible sans ouvrir les journaux.
 */
function annotate(kind, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  console.log(annotation(kind, `Auto-test — ${path.basename(exe)}`, String(message).slice(0, 3500)));
}

function fail(message) {
  const fatal = readFatalError();
  console.error(`\n✖ ${message}`);
  if (fatal) console.error(`\nErreur consignée par l'application :\n${fatal}`);
  annotate('error', fatal ? `${message}\n\n${fatal}` : message);
  summarize(`### ❌ Auto-test de l'exécutable : échec\n\n${message}\n${fatal ? `\n\`\`\`\n${fatal}\n\`\`\`\n` : ''}`);
  process.exit(1);
}

/** Contenu du journal d'erreur fatale, s'il existe. */
function readFatalError() {
  try {
    return readFileSync(fatalFile, 'utf8').trim();
  } catch {
    return '';
  }
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

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail(`Délai invalide : ${timeoutOption}`);
if (!existsSync(exe)) {
  fail(`Exécutable introuvable : ${exe}\n${target === 'electron' ? 'Installez les dépendances avec « npm install ».' : "Compilez-le d'abord avec « npm run build:win »."}`);
}

// Un ancien rapport ne doit jamais pouvoir être pris pour le résultat du jour.
// Seuls les fichiers produits par l'auto-test sont effacés, rien d'autre.
mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (name === 'result.json' || name === 'fatal-error.log' || /^\d{2}-[a-z-]+\.png$/.test(name)) {
    rmSync(path.join(outDir, name), { force: true });
  }
}

console.log(`Auto-test de ${path.relative(root, exe) || exe}`);
console.log(`Résultats  : ${path.relative(root, outDir) || outDir}\n`);

// --- Exécution -------------------------------------------------------------------
const started = Date.now();
// Sorties ignorées : aucun processus de l'application ne peut ainsi retenir la
// console de la compilation ouverte après la fin du test.
const child = spawn(exe, [...extraArgs, `--self-test=${outDir}`], { cwd: root, stdio: 'ignore', windowsHide: false });

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  // Arrête l'application et tous ses processus (moteur de rendu, GPU…).
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}, timeoutSeconds * 1000);

child.on('error', (error) => {
  clearTimeout(timer);
  fail(`Impossible de lancer l'exécutable : ${error.message}`);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (timedOut) fail(`L'application ne s'est pas terminée en ${timeoutSeconds} s : elle a été arrêtée.`);
  if (!existsSync(resultFile)) {
    fail(`L'application s'est terminée (code ${code ?? signal}) sans écrire de rapport : elle n'a pas démarré correctement.`);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch (error) {
    fail(`Rapport illisible (${resultFile}) : ${error.message}`);
  }

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const captures = Array.isArray(report.captures) ? report.captures : [];
  // Mesures des captures : dimensions et nombre de couleurs (une image unie = 1).
  const images = (Array.isArray(report.images) ? report.images : []).filter((image) => Number.isFinite(image?.colors));
  const colors = images.map((image) => image.colors);
  const imagesInfo = images.length ? ` de ${images[0].width} × ${images[0].height} (${Math.min(...colors)} à ${Math.max(...colors)} couleurs)` : '';

  for (const item of checks) {
    console.log(`  ${item.ok ? '✔' : '✖'} ${item.name}${item.ok ? '' : `  →  ${JSON.stringify(item.value)}`}`);
  }
  for (const message of errors) console.log(`  ✖ erreur : ${message}`);
  for (const message of warnings) console.log(`  ! avertissement : ${message}`);

  const passed = checks.filter((item) => item.ok).length;
  const success = code === 0 && report.ok === true && checks.length > 0 && passed === checks.length && errors.length === 0;
  const size = report.window ? `${report.window.width} × ${report.window.height}` : 'inconnue';
  const engine = report.versions?.electron ? `Electron ${report.versions.electron} (Chromium ${report.versions.chrome})` : 'inconnu';

  console.log(`\n  Contrôles : ${passed}/${checks.length} · captures : ${captures.length}${imagesInfo} · fenêtre : ${size} · durée : ${seconds} s`);
  console.log(`  Moteur    : ${engine}`);
  if (report.executable) console.log(`  Programme : ${report.executable}`);

  summarize(
    [
      `### ${success ? '✅' : '❌'} Auto-test de l'exécutable : ${success ? 'réussi' : 'échec'}`,
      '',
      `${passed}/${checks.length} contrôles · ${captures.length} captures${imagesInfo} · fenêtre ${size} · ${engine} · ${seconds} s`,
      '',
      '| Contrôle | Résultat |',
      '| --- | --- |',
      ...checks.map((item) => `| ${item.name} | ${item.ok ? '✅' : `❌ \`${JSON.stringify(item.value)}\``} |`),
      ...errors.map((message) => `| Erreur : ${String(message).replaceAll('|', '\\|').replaceAll('\n', ' ')} | ❌ |`),
      '',
    ].join('\n'),
  );

  const overview = `${passed}/${checks.length} contrôles · ${captures.length} captures${imagesInfo} · fenêtre ${size} · ${engine} · ${seconds} s`;

  if (!success) {
    const fatal = readFatalError();
    if (fatal) console.error(`\nErreur consignée par l'application :\n${fatal}`);
    if (code !== 0) console.error(`\n✖ Code de sortie de l'application : ${code ?? signal}`);
    console.error("\n✖ Auto-test en échec : l'exécutable ne doit pas être distribué.");
    annotate(
      'error',
      [
        `Auto-test en échec — ${overview} — code de sortie ${code ?? signal}`,
        ...checks.filter((item) => !item.ok).map((item) => `✖ ${item.name} → ${JSON.stringify(item.value)}`),
        ...errors.map((message) => `✖ erreur : ${message}`),
        ...warnings.slice(0, 5).map((message) => `! avertissement : ${message}`),
        ...(fatal ? ['', fatal] : []),
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log('\n✔ Auto-test réussi.');
  annotate(
    'notice',
    [`Auto-test réussi — ${overview}`, ...(report.executable ? [`Programme : ${report.executable}`] : []), ...warnings.slice(0, 5).map((message) => `! avertissement : ${message}`)].join('\n'),
  );
});
