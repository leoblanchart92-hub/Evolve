#!/usr/bin/env node
/**
 * Evolve — Vérification de l'installateur (Evolve-Setup-<version>.exe).
 *
 * Sur une machine Windows où Evolve n'est pas installé, ce script :
 *
 *   1. lance l'installateur sans aucune fenêtre, comme le ferait une mise à
 *      jour, et attend sa fin ;
 *   2. relève ce que Windows en retient : une seule inscription parmi les
 *      programmes, pour l'utilisateur seul (jamais pour la machine, ce qui
 *      exigerait des droits d'administrateur), dans son profil ; deux
 *      raccourcis vers le programme installé ; rien au démarrage de Windows ;
 *   3. inspecte le dossier installé : programme, désinstallateur et module
 *      natif présents, aucun droit d'administrateur demandé, aucun outil
 *      d'élévation, aucune copie de l'installateur conservée dans le profil ;
 *   4. lance le programme installé avec son auto-test complet (voir
 *      check-exe.mjs) : c'est bien ce que l'installateur a posé qui fonctionne ;
 *   5. désinstalle par la commande que l'installateur a inscrite — celle que
 *      Windows emploierait — et vérifie qu'il ne reste ni dossier, ni
 *      raccourci, ni inscription, et que les réglages de l'utilisateur
 *      (%APPDATA%\Evolve) n'ont pas été touchés.
 *
 * La machine est laissée telle qu'elle était. Si Evolve y est déjà installé,
 * rien n'est lancé : la vérification le remplacerait, puis le désinstallerait.
 *
 * Utilisation :
 *   node scripts/check-setup.mjs [INSTALLATEUR] [options]
 *
 *   INSTALLATEUR     par défaut : dist/Evolve-Setup-<version>.exe
 *   --out=DOSSIER    résultats (par défaut : self-test-output/installation/)
 *   --skip-self-test n'exécute pas l'auto-test du programme installé
 *   --timeout=SECONDES  durée maximale de l'installation
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { annotation } from './ci-annotate.mjs';
import { executionLevels, verdict } from './check-manifest.mjs';
import {
  APP_EXE,
  INSTALLER_COPY_DIR,
  UNINSTALLER_EXE,
  expectedInstallDir,
  formatSize,
  installDirOf,
  installProblems,
  installSilently,
  inventory,
  namesIn,
  profileChanges,
  readInstallState,
  uninstallLeftovers,
  uninstallSilently,
} from './setup-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Fichiers que le dossier installé doit contenir. */
const REQUIRED_FILES = [APP_EXE, UNINSTALLER_EXE, path.join('resources', 'app.asar'), path.join('resources', 'app.asar.unpacked', 'native', 'build', 'Release', 'evolve_fs.node')];
/** Outil d'élévation de droits qu'electron-builder sait embarquer : Evolve n'en a aucun usage. */
const ELEVATION_TOOLS = ['elevate.exe'];
/** Fichier témoin placé dans le dossier des réglages, s'il n'existe pas, le temps de la désinstallation. */
const WITNESS = 'temoin-de-desinstallation.txt';

/**
 * @param {string[]} argv
 * @returns {{ setup: string, outDir: string, selfTest: boolean, timeoutSeconds: number }}
 */
export function parseOptions(argv, { version = pkg.version } = {}) {
  const option = (name) => {
    const arg = argv.find((item) => item.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : null;
  };
  const target = argv.find((arg) => !arg.startsWith('--')) ?? null;
  const timeout = option('timeout');
  return {
    setup: path.resolve(target ?? path.join(root, 'dist', `Evolve-Setup-${version}.exe`)),
    outDir: path.resolve(option('out') ?? path.join(root, 'self-test-output', 'installation')),
    selfTest: !argv.includes('--skip-self-test'),
    timeoutSeconds: timeout === null ? 300 : Number(timeout),
  };
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

async function main(argv) {
  const options = parseOptions(argv);
  const label = path.basename(options.setup);
  /** Lignes du compte rendu : « ✔ … », « ✖ … » ou « · … » (simple information). */
  const lines = [];
  let failed = false;
  const pass = (text) => {
    lines.push(`✔ ${text}`);
    console.log(`  ✔ ${text}`);
  };
  const fail = (text) => {
    failed = true;
    lines.push(`✖ ${text}`);
    console.error(`  ✖ ${text}`);
  };
  const note = (text) => {
    lines.push(`· ${text}`);
    console.log(`  · ${text}`);
  };
  const finish = () => {
    const title = `Installation — ${label}`;
    const verdictLine = failed ? "Installation en échec : l'installateur ne doit pas être distribué." : 'Installation, auto-test du programme installé et désinstallation conformes.';
    console.log(`\n${failed ? '✖' : '✔'} ${verdictLine}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(annotation(failed ? 'error' : 'notice', title, [verdictLine, ...lines].join('\n').slice(0, 3500)));
    summarize([`### ${failed ? '❌' : '✅'} ${title}`, '', verdictLine, '', ...lines.map((line) => `- ${line}`), ''].join('\n'));
    return failed ? 1 : 0;
  };

  console.log(`Vérification de l'installateur ${path.relative(root, options.setup) || options.setup}\n`);

  if (process.platform !== 'win32') {
    fail("cette vérification installe réellement Evolve : elle ne s'exécute que sous Windows");
    return finish();
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    fail('délai invalide (--timeout)');
    return finish();
  }
  if (!existsSync(options.setup)) {
    fail(`installateur introuvable : ${options.setup} — fabriquez-le d'abord avec « npm run build:win »`);
    return finish();
  }
  mkdirSync(options.outDir, { recursive: true });

  // --- L'installateur lui-même -------------------------------------------------------
  const setupBytes = readFileSync(options.setup);
  const setupLevel = verdict(executionLevels(setupBytes));
  if (setupLevel === 'ok') pass(`installateur : ${formatSize(setupBytes.length)}, aucun droit d'administrateur demandé (asInvoker) — SHA-256 ${createHash('sha256').update(setupBytes).digest('hex')}`);
  else fail(setupLevel === 'elevation' ? "l'installateur demande une élévation de droits" : "niveau d'exécution de l'installateur illisible");

  // --- Avant : Evolve ne doit pas être installé ---------------------------------------
  let before;
  try {
    before = readInstallState();
  } catch (error) {
    fail(error.message);
    return finish();
  }
  const installDir = expectedInstallDir(before);
  if (before.user.length > 0 || before.machine.length > 0 || existsSync(installDir)) {
    fail(`Evolve est déjà installé sur cette machine (${[...before.user, ...before.machine].map((item) => item.name).join(', ') || installDir}) : la vérification le remplacerait puis le désinstallerait. Rien n'a été lancé.`);
    return finish();
  }
  const settingsDir = path.join(before.appData, 'Evolve');
  const profileBefore = {
    local: namesIn(before.localAppData),
    programs: namesIn(path.join(before.localAppData, 'Programs')),
    roaming: namesIn(before.appData),
    settings: existsSync(settingsDir) ? namesIn(settingsDir) : null,
  };

  // --- 1. Installation ------------------------------------------------------------------
  const installed = installSilently(options.setup, { timeout: options.timeoutSeconds * 1000 });
  let entry = null;
  try {
    if (!installed.ok) {
      fail(`installation silencieuse en échec après ${installed.seconds} s : ${installed.detail}`);
    } else {
      // --- 2. Ce que Windows retient -------------------------------------------------------
      const state = readInstallState();
      writeFileSync(path.join(options.outDir, 'installation.json'), `${JSON.stringify(state, null, 2)}\n`);
      [entry = null] = state.user;
      const problems = installProblems(state, { version: pkg.version });
      if (problems.length === 0) {
        pass(`installé en ${installed.seconds} s pour l'utilisateur seul, sans droits d'administrateur : ${installDirOf(entry)}`);
        pass(`inscrit parmi les programmes de l'utilisateur (« ${entry.name} »), absent de ceux de la machine`);
        pass(`raccourcis du menu Démarrer et du bureau : ils mènent à ${APP_EXE}, sans argument`);
        pass('rien au démarrage de Windows (ni registre, ni dossier Démarrage)');
      } else {
        for (const problem of problems) fail(problem);
      }

      // --- 3. Le dossier installé -----------------------------------------------------------
      const missing = REQUIRED_FILES.filter((name) => !existsSync(path.join(installDir, name)));
      const content = inventory(installDir, { watch: ELEVATION_TOOLS });
      if (missing.length > 0) fail(`fichiers absents du dossier installé : ${missing.join(', ')}`);
      else pass(`dossier installé complet : ${content.files} fichiers, ${formatSize(content.bytes)} (programme, désinstallateur, module natif)`);
      if (content.found.length > 0) fail(`outil d'élévation de droits embarqué : ${content.found.join(', ')}`);
      else pass("aucun outil d'élévation de droits dans le dossier installé");
      for (const name of [APP_EXE, UNINSTALLER_EXE]) {
        const file = path.join(installDir, name);
        if (!existsSync(file)) continue;
        const level = verdict(executionLevels(readFileSync(file)));
        if (level === 'ok') pass(`${name} : aucun droit d'administrateur demandé (asInvoker)`);
        else fail(level === 'elevation' ? `${name} demande une élévation de droits` : `${name} : niveau d'exécution illisible`);
      }
      if (existsSync(path.join(before.localAppData, INSTALLER_COPY_DIR))) fail(`une copie de l'installateur est restée dans le profil : ${path.join(before.localAppData, INSTALLER_COPY_DIR)}`);
      else pass("aucune copie de l'installateur conservée dans le profil");

      const local = profileChanges(profileBefore.local, namesIn(before.localAppData), ['Programs']);
      const programs = profileChanges(profileBefore.programs, namesIn(path.join(before.localAppData, 'Programs')), ['Evolve']);
      const roaming = profileChanges(profileBefore.roaming, namesIn(before.appData), []);
      const unexpected = [...local.unexpected.map((name) => `%LOCALAPPDATA%\\${name}`), ...programs.unexpected.map((name) => `%LOCALAPPDATA%\\Programs\\${name}`), ...roaming.unexpected.map((name) => `%APPDATA%\\${name}`)];
      if (unexpected.length > 0) fail(`dossiers inattendus créés dans le profil : ${unexpected.join(', ')}`);
      else pass("dans le profil, l'installation n'a créé que le dossier du programme : aucun réglage, aucun dossier de données");

      // --- 4. Le programme installé fonctionne ---------------------------------------------
      if (!options.selfTest) {
        note('auto-test du programme installé non exécuté (--skip-self-test)');
      } else if (existsSync(path.join(installDir, APP_EXE))) {
        console.log('');
        const selfTest = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-exe.mjs'), path.join(installDir, APP_EXE), '--require-input', `--out=${path.join(options.outDir, 'auto-test')}`], {
          cwd: root,
          stdio: 'inherit',
          timeout: 600_000,
        });
        console.log('');
        if (selfTest.status === 0) pass('auto-test complet du programme installé : réussi (détail dans son propre compte rendu)');
        else fail(`auto-test du programme installé en échec (code ${selfTest.status ?? selfTest.signal ?? selfTest.error?.message})`);
        const after = profileChanges(profileBefore.roaming, namesIn(before.appData), []);
        if (after.unexpected.length > 0) fail(`l'auto-test du programme installé a écrit dans le profil : ${after.unexpected.join(', ')}`);
      }
    }
  } catch (error) {
    fail(`vérification interrompue : ${error.message}`);
  } finally {
    // --- 5. Désinstallation : la machine est laissée telle qu'elle était ------------------
    let state = null;
    try {
      state = readInstallState();
    } catch (error) {
      fail(error.message);
    }
    const current = state?.user[0] ?? entry;
    if (current) {
      // Les réglages de l'utilisateur doivent survivre à la désinstallation. S'il n'en a pas, un fichier
      // témoin en tient lieu, le temps de la vérification.
      let witness = null;
      if (profileBefore.settings === null && !existsSync(settingsDir)) {
        try {
          mkdirSync(settingsDir, { recursive: true });
          witness = path.join(settingsDir, WITNESS);
          writeFileSync(witness, 'Fichier témoin : la désinstallation ne doit pas supprimer ce dossier.\n');
        } catch (error) {
          witness = null;
          note(`fichier témoin impossible à créer dans ${settingsDir} : ${error.message}`);
        }
      }
      const kept = existsSync(settingsDir) ? namesIn(settingsDir) : null;

      const removed = await uninstallSilently(current);
      if (!removed.ok) {
        fail(`désinstallation en échec : ${removed.detail}`);
      } else {
        const left = uninstallLeftovers(removed.state);
        if (existsSync(installDir)) left.push(`dossier ${installDir}`);
        if (existsSync(path.join(before.localAppData, INSTALLER_COPY_DIR))) left.push(`dossier ${path.join(before.localAppData, INSTALLER_COPY_DIR)}`);
        if (left.length > 0) fail(`restes après la désinstallation : ${left.join(' ; ')}`);
        else pass("désinstallation par la commande inscrite : dossier, raccourcis et inscription retirés");

        if (kept !== null) {
          const now = existsSync(settingsDir) ? namesIn(settingsDir) : null;
          if (now !== null && JSON.stringify(now) === JSON.stringify(kept)) pass(`réglages de l'utilisateur conservés par la désinstallation (${settingsDir}${witness ? ', fichier témoin' : ''})`);
          else fail(`la désinstallation a modifié le dossier des réglages ${settingsDir} : ${JSON.stringify(kept)} → ${JSON.stringify(now)}`);
        }
        // Le dossier « Programs » du profil, créé au besoin par l'installateur, peut rester, vide.
        const programsDir = path.join(before.localAppData, 'Programs');
        if (!profileBefore.local.some((name) => name.toLowerCase() === 'programs') && existsSync(programsDir)) {
          const rest = namesIn(programsDir);
          note(rest.length === 0 ? `reste un dossier vide, que Windows réserve aux programmes de l'utilisateur : ${programsDir}` : `le dossier ${programsDir}, créé par l'installation, contient encore : ${rest.join(', ')}`);
        }
      }

      // Ce que la vérification a elle-même créé est retiré.
      if (witness) {
        try {
          rmSync(witness, { force: true });
          rmdirSync(settingsDir);
        } catch (error) {
          note(`fichier témoin non retiré : ${error.message}`);
        }
      }
    }
  }
  return finish();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`\n✖ ${error?.stack ?? error}`);
      process.exit(1);
    },
  );
}

export { REQUIRED_FILES };
