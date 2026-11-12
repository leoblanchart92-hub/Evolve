/**
 * Fausse application utilisée par les tests de scripts/check-exe.mjs et de
 * scripts/check-settings.mjs. Elle imite les comportements possibles de
 * l'exécutable lancé avec `--self-test=DOSSIER` : réussite, échec, absence de
 * rapport, blocage… Les modes « settings-… » imitent les deux lancements de la
 * vérification des réglages (`--settings-dir`, `--self-test-scenario`) ; les
 * modes « documents-… », l'application lancée par scripts/check-documents.mjs
 * alors que le dossier Documents a été mis de côté.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const mode = process.argv[2];
const option = (name) => {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};
const outDir = option('self-test');

const report = (ok, checks, errors = [], extra = {}) => {
  writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify({ ok, checks, errors, warnings: [], captures: [], window: { width: 1600, height: 900 }, versions: {}, ...extra }),
  );
};

if (mode?.startsWith('settings-')) settingsMode();
if (mode?.startsWith('documents-')) documentsMode();

switch (mode) {
  case 'pass':
    report(true, [{ name: 'contrôle un', ok: true }, { name: 'contrôle deux', ok: true }]);
    process.exit(0);
    break;
  case 'pass-with-images': // réussite avec captures mesurées
    report(true, [{ name: 'contrôle un', ok: true }], [], {
      captures: ['01-bureau.png', '02-menu-demarrer.png'],
      images: [
        { file: '01-bureau.png', width: 1600, height: 900, colors: 278 },
        { file: '02-menu-demarrer.png', width: 1600, height: 900, colors: 352 },
      ],
      versions: { electron: '45.2.3', chrome: '156.0.0.0' },
    });
    process.exit(0);
    break;
  case 'pass-with-explorer': // réussite, avec les emplacements trouvés par l'explorateur
    report(true, [{ name: 'contrôle un', ok: true }], [], { explorer: { places: ['desktop', 'documents'], drives: ['C:', 'D:'] } });
    process.exit(0);
    break;
  case 'fail-with-explorer': // échec, sans dossier personnel ni lecteur
    report(false, [{ name: 'contrôle un', ok: false, value: false }], [], { explorer: { places: [], drives: [] } });
    process.exit(1);
    break;
  case 'pass-with-odd-explorer': // information mal formée : ignorée
    report(true, [{ name: 'contrôle un', ok: true }], [], { explorer: { places: 'desktop', drives: null } });
    process.exit(0);
    break;
  case 'fail':
    report(false, [{ name: 'contrôle un', ok: true }, { name: 'contrôle deux', ok: false, value: { attendu: 1 } }]);
    process.exit(1);
    break;
  case 'console-error':
    report(false, [{ name: 'contrôle un', ok: true }], ['console : erreur simulée']);
    process.exit(1);
    break;
  case 'lying-exit-code': // rapport en échec mais code de sortie 0
    report(false, [{ name: 'contrôle un', ok: false, value: false }]);
    process.exit(0);
    break;
  case 'lying-report': // rapport « ok » mais code de sortie en erreur
    report(true, [{ name: 'contrôle un', ok: true }]);
    process.exit(3);
    break;
  case 'empty-report': // rapport « ok » sans aucun contrôle
    report(true, []);
    process.exit(0);
    break;
  case 'silent': // se termine sans écrire de rapport
    process.exit(0);
    break;
  case 'fatal': // erreur fatale consignée par l'application, pas de rapport
    writeFileSync(path.join(outDir, 'fatal-error.log'), 'Error: panne simulée\n    at start (main.js:1:1)\n');
    process.exit(1);
    break;
  case 'hang': // ne se termine jamais
    setInterval(() => {}, 1000);
    break;
  default:
    process.exit(2);
}

/**
 * Modes « settings-… » : le comportement dépend du scénario demandé.
 *   settings-ok              application conforme ;
 *   settings-not-saved       ne crée aucun fichier de réglages ;
 *   settings-wrong-values    enregistre d'autres valeurs que celles modifiées ;
 *   settings-missing-value   oublie un réglage modifié ;
 *   settings-bad-json        écrit un fichier tronqué ;
 *   settings-bad-schema      note un format inattendu ;
 *   settings-bad-version     note une autre version de l'application ;
 *   settings-extra-file      laisse un autre fichier dans le dossier ;
 *   settings-write-fails     premier lancement en échec ;
 *   settings-read-fails      second lancement en échec (réglages non retrouvés) ;
 *   settings-rewritten       le second lancement réécrit le fichier ;
 *   settings-deleted         le second lancement supprime le fichier ;
 *   settings-ignores-dir     écrit ailleurs que dans le dossier demandé.
 */
function settingsMode() {
  const require = createRequire(import.meta.url);
  const { CHANGED_SETTINGS } = require('../../src/main/selftest-settings.js');
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  const scenario = option('self-test-scenario');
  const dir = option('settings-dir');
  const file = path.join(dir, 'settings.json');
  // Journal des lancements, pour que les tests sachent ce qui a été demandé.
  if (process.env.FAKE_APP_LOG) appendFileSync(process.env.FAKE_APP_LOG, `${scenario} ${dir}\n`);

  const save = (content, target = file) => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  const content = (overrides = {}) => ({ schema: 1, app: version, savedAt: '2026-11-10T08:30:00.000Z', values: { ...CHANGED_SETTINGS }, ...overrides });
  const pass = () => {
    report(true, [{ name: `scénario ${scenario}`, ok: true }], [], { scenario });
    process.exit(0);
  };
  const failure = (name) => {
    report(false, [{ name, ok: false, value: { 'quick.volume': 64 } }], [], { scenario });
    process.exit(1);
  };

  if (scenario === 'settings-write') {
    if (existsSync(file)) failure('premier lancement : chaque réglage a sa valeur par défaut');
    switch (mode) {
      case 'settings-not-saved':
        break;
      case 'settings-wrong-values':
        save(content({ values: { ...CHANGED_SETTINGS, 'quick.volume': 64 } }));
        break;
      case 'settings-missing-value': {
        const { 'quick.nightLight': _omitted, ...values } = CHANGED_SETTINGS;
        save(content({ values }));
        break;
      }
      case 'settings-bad-json':
        save('{ "schema": 1, "values": { "quick.vol');
        break;
      case 'settings-bad-schema':
        save(content({ schema: 2 }));
        break;
      case 'settings-bad-version':
        save(content({ app: '0.0.1' }));
        break;
      case 'settings-extra-file':
        save(content());
        save('journal', path.join(dir, 'debug.log'));
        break;
      case 'settings-write-fails':
        failure("l'interface affiche les réglages modifiés");
        break;
      case 'settings-ignores-dir':
        save(content(), path.join(path.dirname(dir), 'ailleurs', 'settings.json'));
        break;
      default:
        save(content());
    }
    pass();
  }

  if (scenario === 'settings-read') {
    if (!existsSync(file)) failure("nouveau lancement : l'interface affiche les réglages enregistrés, sans aucune action");
    switch (mode) {
      case 'settings-read-fails':
        failure("nouveau lancement : l'interface affiche les réglages enregistrés, sans aucune action");
        break;
      case 'settings-rewritten':
        save(content({ savedAt: '2026-11-10T08:31:00.000Z' }));
        break;
      case 'settings-deleted':
        rmSync(file);
        break;
      default:
    }
    pass();
  }

  // Lancé sans scénario de réglages : comportement inattendu.
  process.exit(2);
}

/**
 * Modes « documents-… » : l'application est lancée alors que le dossier
 * Documents (désigné par FAKE_APP_DOCUMENTS) a été mis de côté.
 *   documents-ok                  application conforme : annonce le dossier absent, ne crée rien ;
 *   documents-recreated           recrée le dossier (le défaut corrigé) et le constate elle-même ;
 *   documents-recreated-quietly   recrée le dossier, mais annonce une réussite ;
 *   documents-recreated-filled    recrée le dossier, y dépose un fichier, annonce une réussite ;
 *   documents-recreated-as-file   crée un fichier portant le nom du dossier ;
 *   documents-no-message          ne crée rien, mais n'affiche pas le message attendu ;
 *   documents-check-missing       réussite annoncée, sans l'un des contrôles attendus ;
 *   documents-wrong-scenario      exécute un autre scénario que celui demandé ;
 *   documents-other-folder        crée un autre dossier à côté de l'emplacement de Documents ;
 *   documents-touches-aside       ajoute un fichier dans le dossier mis de côté ;
 *   documents-empties-aside       supprime un fichier du dossier mis de côté ;
 *   documents-moves-aside         renomme le dossier mis de côté.
 */
function documentsMode() {
  const require = createRequire(import.meta.url);
  const { SCENARIO, CHECKS } = require('../../src/main/selftest-documents.js');

  const scenario = option('self-test-scenario');
  const folder = process.env.FAKE_APP_DOCUMENTS;
  const parent = path.dirname(folder);
  // Le dossier mis de côté par le script : même nom, suivi d'un suffixe.
  const aside = readdirSync(parent)
    .filter((name) => name.startsWith(`${path.basename(folder)}.`))
    .map((name) => path.join(parent, name))[0];
  // Journal des lancements : scénario demandé, et état du dossier à cet instant.
  if (process.env.FAKE_APP_LOG) appendFileSync(process.env.FAKE_APP_LOG, `${scenario} ${existsSync(folder) ? 'présent' : 'absent'}\n`);

  const names = ["l'interface a démarré", ...Object.values(CHECKS)];
  const pass = (list = names, extra = {}) => {
    report(true, list.map((name) => ({ name, ok: true })), [], { scenario, captures: ['01-documents-absent.png'], ...extra });
    process.exit(0);
  };
  const failure = (failed, value) => {
    const index = names.indexOf(failed);
    report(false, [...names.slice(0, index).map((name) => ({ name, ok: true })), { name: failed, ok: false, value }], [], { scenario });
    process.exit(1);
  };

  if (scenario !== SCENARIO) failure(names[0], `scénario inattendu : ${scenario}`);
  switch (mode) {
    case 'documents-ok':
      pass();
      break;
    case 'documents-recreated':
      mkdirSync(folder);
      failure(CHECKS.absent, { dossier: folder });
      break;
    case 'documents-recreated-quietly':
      mkdirSync(folder);
      pass();
      break;
    case 'documents-recreated-filled':
      mkdirSync(folder);
      writeFileSync(path.join(folder, 'desktop.ini'), '[.ShellClassInfo]\n');
      pass();
      break;
    case 'documents-recreated-as-file':
      writeFileSync(folder, '');
      pass();
      break;
    case 'documents-no-message':
      failure(CHECKS.tile, { page: 'folder', code: null, message: null });
      break;
    case 'documents-check-missing':
      pass(names.filter((name) => name !== CHECKS.desktop));
      break;
    case 'documents-wrong-scenario':
      pass(names, { scenario: 'full' });
      break;
    case 'documents-other-folder':
      mkdirSync(path.join(parent, 'Mes documents'));
      pass();
      break;
    case 'documents-touches-aside':
      writeFileSync(path.join(aside, 'desktop.ini'), '[.ShellClassInfo]\n');
      pass();
      break;
    case 'documents-empties-aside':
      rmSync(path.join(aside, 'Rapport.txt'));
      pass();
      break;
    case 'documents-moves-aside':
      // Le dossier mis de côté change de nom : pour le script, il a disparu.
      renameSync(aside, path.join(parent, 'Ailleurs'));
      pass();
      break;
    default:
      process.exit(2);
  }
}
