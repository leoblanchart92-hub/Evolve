/**
 * Fausse application utilisée par les tests de scripts/check-launch.mjs.
 * Elle imite l'exécutable lancé normalement avec `--status-file=FICHIER` :
 * elle signale l'état de sa fenêtre, reste ouverte, puis se ferme sur demande
 * (signal SIGTERM) — ou adopte l'un des comportements anormaux à détecter.
 *
 * Comme l'exécutable portable, elle occupe deux dossiers du dossier
 * temporaire — « Evolve-portable » (le programme) et « nsk3F2A.tmp » (le
 * dossier de travail du lanceur) — qu'elle supprime en se fermant. Elle
 * annonce aussi l'emplacement du fichier de ses réglages, dans le profil
 * simulé de l'utilisateur (variable APPDATA), sans y écrire.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const flag = process.argv.find((arg) => arg.startsWith('--status-file='));
const statusFile = flag ? flag.slice('--status-file='.length) : null;

// Le test désigne un dossier temporaire propre à chaque essai (variable TMPDIR).
const unpackDir = path.join(tmpdir(), 'Evolve-portable');
const launcherDir = path.join(tmpdir(), 'nsk3F2A.tmp');
mkdirSync(path.join(unpackDir, 'resources'), { recursive: true });
mkdirSync(path.join(launcherDir, '7z-out'), { recursive: true });
writeFileSync(path.join(unpackDir, 'Evolve.exe'), Buffer.alloc(2048));
writeFileSync(path.join(unpackDir, 'resources', 'app.asar'), Buffer.alloc(1024));
writeFileSync(path.join(launcherDir, '7z-out', 'Evolve.exe'), Buffer.alloc(2048));
writeFileSync(path.join(launcherDir, 'app-64.7z'), Buffer.alloc(3 * 1024 * 1024));
// Numéro de processus : le test vérifie que l'application ne reste jamais ouverte.
writeFileSync(path.join(tmpdir(), 'fake-app.pid'), String(process.pid));

/** Fichier des réglages : dans le profil de l'utilisateur, comme la véritable application. */
const settingsFile = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Evolve', 'settings.json')
  : path.join(tmpdir(), 'configuration', 'evolve', 'settings.json');
const settingsState = (changes = {}) => ({
  settings: {
    state: 'available',
    storage: 'file',
    durable: true,
    problem: null,
    recovered: null,
    file: settingsFile,
    exists: existsSync(settingsFile),
    lastError: null,
    methods: ['getAll', 'get', 'set', 'reset', 'state'],
    events: ['changed', 'state'],
    ...changes,
  },
});
/** Écrit un fichier de réglages, comme si un réglage avait été modifié. */
const writeSettings = (file = settingsFile) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{ "schema": 1, "values": { "quick.volume": 12 } }\n');
};

const FULLSCREEN = {
  ready: true,
  closed: false,
  visible: true,
  fullscreen: true,
  minimized: false,
  focused: true,
  title: 'Evolve',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  display: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
  capture: null,
  startupMs: 1234,
  pid: process.pid,
  executable: path.join(unpackDir, 'Evolve.exe'),
  services: settingsState(),
  versions: { electron: '45.2.3', chrome: '156.0.0.0' },
  errors: [],
};

/** Modifications de l'état demandées par le test (JSON), appliquées en dernier. */
const requested = process.env.FAKE_STATUS ? JSON.parse(process.env.FAKE_STATUS) : {};

const report = (changes = {}) => writeFileSync(statusFile, JSON.stringify({ ...FULLSCREEN, ...changes, ...requested }));

/**
 * Reste ouverte jusqu'à la demande de fermeture, puis quitte avec `code`.
 * @param {{ code?: number, cleanup?: string[], onClose?: () => void }} [options]
 *   `cleanup` : dossiers supprimés à la fermeture ; `onClose` : exécuté juste avant
 */
function stayOpen({ code = 0, cleanup = [unpackDir, launcherDir], onClose = () => {} } = {}) {
  process.on('SIGTERM', () => {
    onClose();
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  });
  setInterval(() => {}, 1000);
}

switch (mode) {
  case 'ok':
    report();
    stayOpen();
    break;
  case 'windowed': // lancée avec --windowed : fenêtre visible, pas en plein écran
    report({ fullscreen: false, bounds: { x: 160, y: 90, width: 1600, height: 900 } });
    stayOpen();
    break;
  case 'not-ready': // l'écran de démarrage ne disparaît jamais
    report({ ready: false });
    stayOpen();
    break;
  case 'hidden':
    report({ visible: false });
    stayOpen();
    break;
  case 'small': // dite « plein écran » mais plus petite que l'écran
    report({ bounds: { x: 0, y: 0, width: 1600, height: 900 } });
    stayOpen();
    break;
  case 'console-error':
    report({ errors: ['console : erreur simulée'] });
    stayOpen();
    break;
  case 'exit-early': // se termine avant d'avoir démarré son interface
    process.exit(1);
    break;
  case 'already-open': // une autre instance est ouverte : rend la main aussitôt, sans erreur
    process.exit(0);
    break;
  case 'never-reports': // ne signale jamais son démarrage
    stayOpen();
    break;
  case 'garbage': // compte rendu illisible
    writeFileSync(statusFile, '{ ceci n’est pas du JSON');
    stayOpen();
    break;
  case 'no-pid':
    report({ pid: null });
    stayOpen();
    break;
  case 'self-exit': // démarre correctement puis se ferme toute seule
    report();
    setTimeout(() => process.exit(0), 50);
    break;
  case 'ignores-close': // ne réagit pas à la demande de fermeture
    report();
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    break;
  case 'bad-exit-code':
    report();
    stayOpen({ code: 3 });
    break;
  case 'leftover': // se ferme sans rien supprimer du dossier temporaire
    report();
    stayOpen({ cleanup: [] });
    break;
  case 'leftover-launcher': // seul le dossier de travail du lanceur subsiste
    report();
    stayOpen({ cleanup: [unpackDir] });
    break;
  case 'writes-profile': // range des données dans le profil de l'utilisateur (AppData)
    mkdirSync(path.join(process.env.APPDATA, 'Evolve'), { recursive: true });
    writeFileSync(path.join(process.env.APPDATA, 'Evolve', 'Preferences'), '{}');
    report();
    stayOpen();
    break;
  case 'no-services': // ancienne version : aucun service, aucun réglage conservé
    report({ services: null });
    stayOpen();
    break;
  case 'settings-memory': // réglages gardés en mémoire seulement
    report({ services: settingsState({ storage: 'memory', durable: false, file: null, exists: false }) });
    stayOpen();
    break;
  case 'settings-local': // réglages rangés au mauvais endroit du profil
    report({ services: settingsState({ file: path.join(process.env.LOCALAPPDATA, 'Evolve', 'settings.json'), exists: false }) });
    stayOpen();
    break;
  case 'settings-unwritable': // le dossier des réglages n'est pas accessible
    report({ services: settingsState({ state: 'limited', durable: false, problem: 'unreadable', lastError: 'EACCES : accès refusé' }) });
    stayOpen();
    break;
  case 'writes-settings-at-start': // écrit ses réglages dès le démarrage, sans que rien n'ait été modifié
    writeSettings();
    report();
    stayOpen();
    break;
  case 'writes-settings-on-close': // écrit ses réglages à la fermeture, sans que rien n'ait été modifié
    report();
    stayOpen({ onClose: () => writeSettings() });
    break;
  case 'deletes-settings': // supprime des réglages existants
    report();
    stayOpen({ onClose: () => rmSync(settingsFile, { force: true }) });
    break;
  case 'custom-settings-dir': { // lancée avec --settings-dir=DOSSIER
    const dir = process.argv.find((arg) => arg.startsWith('--settings-dir=')).slice('--settings-dir='.length);
    const file = path.join(dir, 'settings.json');
    report({ services: settingsState({ file, exists: existsSync(file) }) });
    stayOpen({ onClose: () => process.argv.includes('--write') && writeSettings(file) });
    break;
  }
  case 'development': // lancée hors exécutable portable : aucun dossier temporaire à surveiller
    report({ executable: process.execPath });
    stayOpen();
    break;
  default:
    process.exit(2);
}
