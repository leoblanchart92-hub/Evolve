'use strict';

/**
 * Evolve — Lecture des options de la ligne de commande.
 * Module pur (aucune dépendance à Electron) : testé directement avec Node.
 *
 *   --windowed              démarre dans une fenêtre au lieu du plein écran
 *   --devtools              autorise les outils de développement (touche F12)
 *   --self-test[=DOSSIER]   auto-test : vérifie que l'interface démarre et
 *                           répond, écrit un rapport et des captures d'écran
 *                           dans DOSSIER, puis quitte (voir selftest.js)
 *   --status-file=FICHIER   écrit dans FICHIER l'état de la fenêtre une fois
 *                           l'interface démarrée (voir status.js) ; sert à
 *                           vérifier le lancement normal de l'exécutable
 */

const SELF_TEST_FLAG = '--self-test';
const STATUS_FILE_FLAG = '--status-file';

/** Valeur d'une option de la forme `--nom=valeur` (chaîne vide si absente). */
function valueOf(args, name) {
  const prefix = `${name}=`;
  const arg = args.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : '';
}

/**
 * @param {string[]} argv  arguments du processus (process.argv)
 * @returns {{ windowed: boolean, devtools: boolean, selfTest: boolean, selfTestDir: string|null, statusFile: string|null }}
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(1).map(String) : [];
  const selfTest = args.some((arg) => arg === SELF_TEST_FLAG || arg.startsWith(`${SELF_TEST_FLAG}=`));

  return {
    windowed: args.includes('--windowed'),
    devtools: args.includes('--devtools'),
    selfTest,
    selfTestDir: valueOf(args, SELF_TEST_FLAG) || null,
    statusFile: valueOf(args, STATUS_FILE_FLAG) || null,
  };
}

module.exports = { parseArgs, SELF_TEST_FLAG, STATUS_FILE_FLAG };
