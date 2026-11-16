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
 *   --settings-dir=DOSSIER  conserve les réglages dans DOSSIER plutôt que dans
 *                           le dossier de l'utilisateur (%APPDATA%\Evolve)
 *   --self-test-scenario=NOM  scénario exécuté par l'auto-test (voir
 *                           selftest.js) ; par défaut, le contrôle complet
 *   --updated               ajouté par l'installateur quand il rouvre Evolve
 *                           après une mise à jour : l'interface l'annonce
 *   --update-feed=ADRESSE   vérification de la mise à jour : adresse d'un
 *                           serveur de la machine elle-même (127.0.0.1) qui
 *                           tient lieu de page de publication. Toute autre
 *                           adresse est refusée (voir services/updates.js)
 */

const SELF_TEST_FLAG = '--self-test';
const STATUS_FILE_FLAG = '--status-file';
const SETTINGS_DIR_FLAG = '--settings-dir';
const SELF_TEST_SCENARIO_FLAG = '--self-test-scenario';
const UPDATED_FLAG = '--updated';
const UPDATE_FEED_FLAG = '--update-feed';

/** Valeur d'une option de la forme `--nom=valeur` (chaîne vide si absente). */
function valueOf(args, name) {
  const prefix = `${name}=`;
  const arg = args.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : '';
}

/**
 * @param {string[]} argv  arguments du processus (process.argv)
 * @returns {{ windowed: boolean, devtools: boolean, selfTest: boolean, selfTestDir: string|null,
 *   selfTestScenario: string|null, statusFile: string|null, settingsDir: string|null, updated: boolean,
 *   updateFeed: string|null }}
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(1).map(String) : [];
  const selfTest = args.some((arg) => arg === SELF_TEST_FLAG || arg.startsWith(`${SELF_TEST_FLAG}=`));

  return {
    windowed: args.includes('--windowed'),
    devtools: args.includes('--devtools'),
    selfTest,
    selfTestDir: valueOf(args, SELF_TEST_FLAG) || null,
    selfTestScenario: valueOf(args, SELF_TEST_SCENARIO_FLAG) || null,
    statusFile: valueOf(args, STATUS_FILE_FLAG) || null,
    settingsDir: valueOf(args, SETTINGS_DIR_FLAG) || null,
    updated: args.includes(UPDATED_FLAG),
    updateFeed: valueOf(args, UPDATE_FEED_FLAG) || null,
  };
}

module.exports = { parseArgs, SELF_TEST_FLAG, STATUS_FILE_FLAG, SETTINGS_DIR_FLAG, SELF_TEST_SCENARIO_FLAG, UPDATED_FLAG, UPDATE_FEED_FLAG };
