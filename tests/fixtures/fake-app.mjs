/**
 * Fausse application utilisée par les tests de scripts/check-exe.mjs.
 * Elle imite les comportements possibles de l'exécutable lancé avec
 * `--self-test=DOSSIER` : réussite, échec, absence de rapport, blocage…
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
const flag = process.argv.find((arg) => arg.startsWith('--self-test='));
const outDir = flag ? flag.slice('--self-test='.length) : null;

const report = (ok, checks, errors = [], extra = {}) => {
  writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify({ ok, checks, errors, warnings: [], captures: [], window: { width: 1600, height: 900 }, versions: {}, ...extra }),
  );
};

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
