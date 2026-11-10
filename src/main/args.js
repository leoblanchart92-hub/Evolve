'use strict';

/**
 * Evolve — Lecture des options de la ligne de commande.
 * Module pur (aucune dépendance à Electron) : testé directement avec Node.
 *
 *   --windowed             démarre dans une fenêtre au lieu du plein écran
 *   --devtools             autorise les outils de développement (touche F12)
 *   --self-test[=DOSSIER]  auto-test : vérifie que l'interface démarre et
 *                          répond, écrit un rapport et des captures d'écran
 *                          dans DOSSIER, puis quitte (voir selftest.js)
 */

const SELF_TEST_FLAG = '--self-test';

/**
 * @param {string[]} argv  arguments du processus (process.argv)
 * @returns {{ windowed: boolean, devtools: boolean, selfTest: boolean, selfTestDir: string|null }}
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(1).map(String) : [];
  const flag = args.find((arg) => arg === SELF_TEST_FLAG || arg.startsWith(`${SELF_TEST_FLAG}=`));
  const dir = flag && flag.includes('=') ? flag.slice(flag.indexOf('=') + 1).trim() : '';

  return {
    windowed: args.includes('--windowed'),
    devtools: args.includes('--devtools'),
    selfTest: Boolean(flag),
    selfTestDir: dir || null,
  };
}

module.exports = { parseArgs, SELF_TEST_FLAG };
