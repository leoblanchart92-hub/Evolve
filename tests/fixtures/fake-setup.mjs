/**
 * Faux programme d'installation, utilisé par les tests de
 * scripts/check-setup.mjs. Il imite les comportements possibles d'un
 * installateur NSIS : installation complète, installation incomplète,
 * échec silencieux, blocage, désinstallation laissée en plan…
 *
 * L'application installée est un petit script qui relaye
 * tests/fixtures/fake-app.mjs : l'auto-test de scripts/check-exe.mjs peut
 * ainsi être mené sur l'application « installée ».
 *
 * Utilisation :
 *   node fake-setup.mjs install   --install-dir=… --start-menu=… --desktop=… [options]
 *   node fake-setup.mjs uninstall --install-dir=… --start-menu=… --desktop=… [options]
 *   node fake-setup.mjs fails | nothing | hang
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_APP = path.join(here, 'fake-app.mjs');
const ITSELF = fileURLToPath(import.meta.url);

const mode = process.argv[2] ?? 'install';
const option = (name) => {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const installDir = path.resolve(option('install-dir') ?? '');
const startMenu = path.resolve(option('start-menu') ?? '');
const desktopDir = path.resolve(option('desktop') ?? '');
const settingsDir = path.resolve(option('settings-dir') ?? '');
/** Mode transmis à la fausse application : l'auto-test réussit, échoue… */
const appMode = option('app') ?? 'pass';

/**
 * Contenu d'un petit script exécutable qui relaie un module Node.
 * @param {string} module  chemin du module à lancer
 * @param {string[]} args  arguments qui le précèdent (les siens suivent)
 */
const launcher = (module, args) => `#!/bin/sh
exec "${process.execPath}" "${module}" ${args.map((arg) => `"${arg}"`).join(' ')} "$@"
`;

/** Écrit un fichier exécutable. */
function writeProgram(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  chmodSync(file, 0o755);
}

if (mode === 'fails') process.exit(2);
if (mode === 'nothing') process.exit(0);
if (mode === 'hang') {
  // Ne se termine jamais : la vérification doit finir par l'abandonner.
  setInterval(() => {}, 60_000);
} else if (mode === 'uninstall') {
  if (flag('hang-uninstall')) setInterval(() => {}, 60_000);
  if (flag('fail-uninstall')) process.exit(2);
  if (!flag('leaves-files') && !flag('leaves-folder')) {
    for (const shortcut of [path.join(startMenu, 'Evolve.lnk'), path.join(desktopDir, 'Evolve.lnk')]) {
      try {
        rmSync(shortcut, { force: true });
      } catch {
        /* déjà absent */
      }
    }
    try {
      rmSync(installDir, { recursive: true, force: true });
    } catch {
      /* déjà absent */
    }
  } else if (flag('leaves-folder')) {
    // Le désinstallateur retire les raccourcis et les programmes, mais laisse
    // le dossier d'installation et ce qu'il contient encore.
    for (const shortcut of [path.join(startMenu, 'Evolve.lnk'), path.join(desktopDir, 'Evolve.lnk')]) {
      try {
        rmSync(shortcut, { force: true });
      } catch {
        /* déjà absent */
      }
    }
    for (const entry of readdirSync(installDir)) {
      try {
        rmSync(path.join(installDir, entry), { recursive: true, force: true });
      } catch {
        /* déjà absent */
      }
    }
  } else {
    // Installation mal retirée : les programmes et les raccourcis disparaissent,
    // mais le reste du dossier demeure.
    for (const leftover of [path.join(installDir, 'Evolve.exe'), path.join(installDir, 'Uninstall Evolve.exe')]) {
      try {
        rmSync(leftover, { force: true });
      } catch {
        /* déjà absent */
      }
    }
  }
  if (flag('remove-settings')) rmSync(settingsDir, { recursive: true, force: true });
} else {
  // Installation.
  mkdirSync(installDir, { recursive: true });
  if (!flag('no-exe')) writeProgram(path.join(installDir, 'Evolve.exe'), launcher(FAKE_APP, [appMode]));
  if (!flag('no-uninstaller')) {
    const args = [
      'uninstall',
      `--install-dir=${installDir}`,
      `--start-menu=${startMenu}`,
      `--desktop=${desktopDir}`,
      `--settings-dir=${settingsDir}`,
    ];
    for (const kept of ['leaves-files', 'leaves-folder', 'remove-settings', 'hang-uninstall', 'fail-uninstall']) {
      if (flag(kept)) args.push(`--${kept}`);
    }
    writeProgram(path.join(installDir, 'Uninstall Evolve.exe'), launcher(ITSELF, args));
  }
  if (!flag('few-files')) {
    for (const file of ['resources/app.asar', 'locales/fr.pak', 'LICENSE.electron.txt']) {
      const target = path.join(installDir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'contenu factice', 'utf8');
    }
  }
  if (!flag('no-shortcuts')) {
    if (!flag('no-start-menu')) {
      mkdirSync(startMenu, { recursive: true });
      writeFileSync(path.join(startMenu, 'Evolve.lnk'), 'raccourci', 'utf8');
    }
    if (!flag('no-desktop')) {
      mkdirSync(desktopDir, { recursive: true });
      writeFileSync(path.join(desktopDir, 'Evolve.lnk'), 'raccourci', 'utf8');
    }
  }
  if (!existsSync(installDir)) process.exit(3);
}
