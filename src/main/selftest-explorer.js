'use strict';

/**
 * Evolve — Auto-test : l'explorateur de fichiers parcourt de vrais dossiers.
 *
 * L'auto-test crée un petit dossier d'essai dans son propre dossier de sortie
 * (noms avec espaces, accents et apostrophe), puis s'y rend comme le ferait
 * l'utilisateur : « Ce PC », le lecteur, puis chaque dossier, au double-clic.
 * Il contrôle l'affichage (noms, types, tailles, dates), la navigation
 * (précédent, suivant, dossier parent, actualisation), le message affiché
 * devant un dossier supprimé entre-temps ou protégé, les refus du service de
 * fichiers (chemins hors des emplacements autorisés, opérations d'écriture)
 * et, pour finir, que rien n'a changé dans le dossier parcouru.
 *
 * Seul l'auto-test écrit ces fichiers d'essai, et uniquement dans son dossier
 * de sortie : l'explorateur, lui, ne fait que lire.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Sous-dossier du dossier de sortie qui reçoit les dossiers d'essai. */
const FIXTURE_DIR = 'explorateur';

/** Dossier parcouru : son nom éprouve les espaces, les accents et l'apostrophe. */
const FOLDER_NAME = "Dossier d'essai été 2026";

/** Élément que l'explorateur masque par défaut, selon le système (voir src/services/files.js). */
const hiddenNameFor = (platform) => (platform === 'win32' ? 'Thumbs.db' : '.masque');

/** Contenu du dossier d'essai, dans l'ordre d'affichage attendu : dossiers d'abord, puis fichiers. */
const VISIBLE_NAMES = Object.freeze(['Photos de vacances', 'Sous-dossier vide', 'Budget 2026.xlsx', 'Rapport final.txt', 'Résumé été.pdf']);

/** Fichier dont la vue « Détails » doit afficher le type, la taille et la date. */
const DETAILED_FILE = Object.freeze({
  name: 'Rapport final.txt',
  bytes: 1536,
  type: 'Document texte',
  size: '1,5 Ko',
  modified: new Date(2026, 2, 14, 15, 9, 0),
  date: '14/03/2026 15:09',
});

/** Fichier ajouté pendant le test, que « Actualiser » doit faire apparaître. */
const ADDED_NAME = 'Ajouté pendant le test.txt';

/** Dossier retiré pendant le test, alors que l'explorateur l'affiche encore. */
const REMOVED_NAME = 'Retiré pendant le test';

/** Opérations qu'un explorateur en lecture seule ne doit pas proposer. */
const WRITE_METHODS = Object.freeze(['write', 'create', 'mkdir', 'rename', 'move', 'copy', 'delete', 'remove', 'trash', 'open', 'read']);

/** Outils exécutés dans la page : lecture de l'état de la fenêtre de l'explorateur. */
const PAGE_TOOLS = `
  const exWin = () => document.querySelector('.window[data-app="explorer"]');
  const exContent = () => exWin().querySelector('.ex-content');
  const exItems = () => [...exWin().querySelectorAll('.ex-item')];
  const exName = (el) => el.querySelector('.ex-tile__name, .ex-row__name > .truncate, .ex-drive__name')?.textContent ?? '';
  const exNames = () => exItems().map(exName);
  const exCrumbs = () => [...exWin().querySelectorAll('.ex-crumb span')].map((el) => el.textContent);
  const exStatus = () => exWin().querySelector('.ex-status__text').textContent.replace(/[\\u00a0\\u202f]/g, ' ');
  const exMessage = () => exWin().querySelector('.ex-empty strong')?.textContent ?? null;
  const exBusy = () => exContent().getAttribute('aria-busy') === 'true';
  const exState = () => ({ page: exContent().dataset.page, path: exContent().dataset.path, code: exContent().dataset.code,
    message: exMessage(), elements: exNames().slice(0, 12) });
  const exOpen = (id) => {
    const el = exItems().find((item) => item.dataset.id === id);
    if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Boolean(el);
  };
  const exButton = (label) => exWin().querySelector('.ex-nav [aria-label^="' + label + '"]');
  const files = (...args) => window.evolve.services.call('files', ...args);
`;

const js = (value) => JSON.stringify(value);

/**
 * Crée le dossier d'essai. Chaque exécution reçoit un dossier neuf : un essai
 * précédent, laissé sur place, ne fausse rien.
 * @param {string} outDir  dossier de sortie de l'auto-test
 * @param {string} [platform]  système visé : il décide du nom de l'élément masqué
 * @returns {{ folder: string, sub: string, empty: string, added: string, removed: string, hidden: string }} chemins réels
 */
function createFixture(outDir, platform = process.platform) {
  const hidden = hiddenNameFor(platform);
  const base = path.join(outDir, FIXTURE_DIR);
  fs.mkdirSync(base, { recursive: true });
  // Chemin réel (noms longs, lettre du lecteur en capitale) : celui que l'explorateur affichera.
  const run = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'essai-')));
  const folder = path.join(run, FOLDER_NAME);
  const sub = path.join(folder, VISIBLE_NAMES[0]);
  const empty = path.join(folder, VISIBLE_NAMES[1]);
  const removed = path.join(folder, REMOVED_NAME);
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(empty);
  fs.mkdirSync(removed);
  fs.writeFileSync(path.join(sub, 'plage.jpg'), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(folder, 'Budget 2026.xlsx'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(folder, 'Résumé été.pdf'), Buffer.alloc(512, 2));
  fs.writeFileSync(path.join(folder, hidden), '');
  const detailed = path.join(folder, DETAILED_FILE.name);
  fs.writeFileSync(detailed, Buffer.alloc(DETAILED_FILE.bytes, 3));
  fs.utimesSync(detailed, DETAILED_FILE.modified, DETAILED_FILE.modified);
  return { folder, sub, empty, added: path.join(folder, ADDED_NAME), removed, hidden };
}

/** État d'un dossier : chaque élément avec sa taille, sa date et l'empreinte de son contenu. */
function snapshot(folder) {
  const lines = [];
  (function walk(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, item.name);
      const info = fs.lstatSync(full);
      const relative = path.relative(folder, full);
      if (item.isDirectory()) {
        lines.push(`${relative}/`);
        walk(full);
      } else {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        lines.push(`${relative} ${info.size} ${Math.round(info.mtimeMs)} ${digest}`);
      }
    }
  })(folder);
  return lines.join('\n');
}

/** Code de page : attend l'affichage du dossier `target` ; tant qu'il ne l'est pas, exécute `action`. */
const reach = (target, action) => `${PAGE_TOOLS}
    if (exContent().dataset.path === ${js(target)}) return true;
    if (!exBusy()) { ${action} }
    return { attendu: ${js(target)}, ...exState() };`;

/** Code de page : clic sur un bouton de navigation (« Précédent », « Suivant », « Dossier parent », « Actualiser »). */
const clickNav = (label) => `exButton(${js(label)}).click();`;

/**
 * Dossiers de Windows fermés aux comptes d'utilisateur, du plus courant au
 * moins courant. Selon la machine et les droits du compte, certains peuvent
 * être lisibles : le premier qui refuse l'accès sert au contrôle.
 */
const protectedFolders = (drive) => [
  `${drive}\\System Volume Information`,
  `${drive}\\Program Files\\WindowsApps`,
  `${drive}\\ProgramData\\Microsoft\\Windows\\SystemData`,
];

/**
 * Dossier protégé de Windows : l'explorateur affiche « Accès refusé » et la
 * navigation continue. Partie de `backTo`, le dossier affiché, elle y revient.
 *
 * Si aucun des dossiers connus ne refuse l'accès sur cette machine (compte
 * aux droits étendus), le contrôle est omis et un avertissement le signale.
 * @param {object} tools  outils de l'auto-test
 * @param {{ drive: string, backTo: string }} target  lecteur du système (« C: ») et dossier de retour
 */
async function checkProtectedFolder({ check, act, until, evaluate, report }, { drive, backTo }) {
  const candidates = protectedFolders(drive);
  // Le service est interrogé directement : quel dossier refuse l'accès ?
  let probe;
  try {
    probe = await evaluate(
      `const tried = {};
       for (const [index, target] of ${js(candidates)}.entries()) {
         const reply = await window.evolve.services.call('files', 'list', target);
         if (reply.ok === false && reply.code === 'access-denied') return index === 0 ? true : { index, tried };
         tried[target] = reply.ok ? 'lisible' : (reply.code ?? null);
       }
       return { tried };`,
    );
  } catch (error) {
    probe = { exception: error?.message };
  }
  const index = probe === true ? 0 : Number.isInteger(probe?.index) && probe.index > 0 && probe.index < candidates.length ? probe.index : -1;
  if (index < 0) {
    report.warnings.push(`dossier protégé non vérifié (aucun refus d'accès sur cette machine : ${JSON.stringify(probe?.tried ?? probe)})`);
    return;
  }

  // Trajet : le lecteur du système, puis chaque dossier jusqu'au parent du dossier protégé.
  const target = candidates[index];
  const [root, ...folders] = stepsTo(path.win32.dirname(target));
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="drive:${drive}"]').click();`);
  let arrived = await until(reach(root.path, ''));
  for (const step of folders) {
    if (arrived !== true) break;
    arrived = await until(reach(step.path, `exOpen(${js(step.id)});`));
  }
  const parent = folders.length ? folders.at(-1).path : root.path;

  // Aller : double-clic sur le dossier protégé. Retour : « Précédent », qui rend « Suivant » disponible.
  await check(
    'un dossier protégé de Windows affiche « Accès refusé », sans bloquer la navigation',
    `${PAGE_TOOLS}
     const state = exState();
     if (state.page === 'folder' && state.path === ${js(parent)}) {
       if (exButton('Suivant').getAttribute('aria-disabled') === 'false') return true;
       if (!exBusy()) state.ouvert = exOpen(${js(target)});
     } else if (state.page === 'error' && state.code === 'access-denied' && state.message === 'Accès refusé'
       && exCrumbs().at(-1) === ${js(path.win32.basename(target))} && exItems().length === 0) {
       if (!exBusy()) exButton('Précédent').click();
     }
     return state;`,
  );
  // Retour au dossier de départ, un pas en arrière après l'autre.
  await until(reach(backTo, clickNav('Précédent')));
}

/** Étapes du trajet de « Ce PC » à `folder` : le lecteur, puis chaque dossier. */
function stepsTo(folder) {
  // Chemin de Windows (« C:\\… ») ou d'un autre système (« /… ») : reconnu à sa forme.
  const windows = /^[A-Za-z]:[\\/]/.test(folder);
  const P = windows ? path.win32 : path.posix;
  const { root } = P.parse(folder);
  // Lecteur désigné comme dans l'interface : « C: » sous Windows, « / » ailleurs.
  const steps = [{ id: `drive:${windows ? root.slice(0, 2) : root}`, path: root }];
  let current = root;
  for (const name of P.relative(root, folder).split(P.sep).filter(Boolean)) {
    current = P.join(current, name);
    steps.push({ id: current, path: current });
  }
  return steps;
}

/**
 * Contrôles de l'explorateur de fichiers (la fenêtre de l'explorateur est ouverte).
 * @param {object} tools  outils de l'auto-test (voir selftest.js) ; `platform` et
 *        `env` désignent le système sur lequel l'application s'exécute
 */
async function checkExplorer({ check, act, until, evaluate, record, capture, report, outDir, describeServices, platform = process.platform, env = process.env }) {
  const isWindows = platform === 'win32';
  const toggleHidden = `${PAGE_TOOLS}
    [...exWin().querySelectorAll('.ex-commands .btn')].find((el) => el.textContent.trim() === 'Affichage').click();
    [...document.querySelectorAll('.menu:not(.is-closing) .menu__item')]
      .find((el) => el.querySelector('.menu__label')?.textContent === 'Éléments masqués').click();`;

  // 1. Vrais dossiers, lecture seule : plus aucun contenu d'exemple.
  await check(
    "l'explorateur consulte les vrais dossiers, en lecture seule (aucun contenu d'exemple)",
    `${PAGE_TOOLS}
     const chips = [...exWin().querySelectorAll('.chip')].map((chip) => chip.textContent);
     return (exContent().dataset.page === 'home' && exItems().length === 6 && chips.length === 1 && chips[0] === 'Lecture seule')
       || { chips, ...exState() };`,
  );

  // 2. « Ce PC » : dossiers personnels et lecteurs réels.
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="pc"]').click();`);
  await check(
    '« Ce PC » présente les dossiers personnels et les lecteurs de cet ordinateur',
    `${PAGE_TOOLS}
     const drives = [...exWin().querySelectorAll('.ex-drive')];
     const sized = drives.every((drive) => /libres sur|Capacité inconnue/.test(drive.querySelector('.ex-drive__meta').textContent));
     return (exContent().dataset.page === 'pc' && drives.length >= 1 && sized && exItems().length === 6 + drives.length
       && exWin().querySelectorAll('.ex-sidebar__drives .ex-side').length === drives.length) || exState();`,
  );
  // Ce que cette machine expose, pour le compte rendu (information, pas un contrôle).
  try {
    const found = await evaluate(
      `const reply = await window.evolve.services.call('files', 'places');
       return reply.ok ? { places: reply.value.places.filter((place) => place.available).map((place) => place.id),
         drives: reply.value.drives.map((drive) => drive.id) } : null;`,
    );
    if (found && typeof found === 'object') report.explorer = found;
  } catch {
    /* information facultative */
  }
  // Chaque dossier personnel disponible est lisible par le service ; le premier est ouvert dans l'interface.
  let personal;
  try {
    personal = await evaluate(
      `${PAGE_TOOLS}
       const places = (await files('places')).value.places.filter((place) => place.available);
       if (!places.length) return { dossiers: 'aucun dossier personnel disponible' };
       const refused = [];
       for (const place of places) {
         const reply = await files('list', place.path);
         if (!reply.ok || reply.value.root.kind !== 'place') refused.push({ dossier: place.id, code: reply.code ?? null });
       }
       return refused.length ? { refused } : { first: { id: places[0].id, path: places[0].path } };`,
    );
  } catch (error) {
    personal = `exception : ${error?.message}`;
  }
  if (/^[a-z]+$/.test(personal?.first?.id ?? '') && typeof personal.first.path === 'string') {
    const { id, path: folder } = personal.first;
    personal = await until(
      `${PAGE_TOOLS}
       if (exContent().dataset.path !== ${js(folder)}) {
         if (!exBusy()) exWin().querySelector('.ex-side[data-id="place:${id}"]').click();
         return { attendu: ${js(folder)}, ...exState() };
       }
       const crumbs = exCrumbs();
       return (crumbs.length === 2 && crumbs[0] === 'Ce PC'
         && exWin().querySelector('.ex-side.is-current')?.dataset.id === 'place:${id}') || { crumbs, ...exState() };`,
    );
  }
  record("chaque dossier personnel disponible s'ouvre (Bureau, Documents, Téléchargements, Images, Musique, Vidéos)", personal);

  // 3. Dossier d'essai : créé ici, par l'auto-test, dans son dossier de sortie.
  let fixture;
  /** État que le dossier d'essai doit avoir : celui dans lequel l'auto-test l'a laissé. */
  let expected;
  /** Faux dès qu'un écart est constaté. */
  let intact = true;
  try {
    fixture = createFixture(outDir, platform);
    expected = snapshot(fixture.folder);
  } catch (error) {
    report.errors.push(`dossier d'essai de l'explorateur impossible à créer : ${error?.message}`);
    return;
  }
  /**
   * L'auto-test modifie lui-même le dossier d'essai : il vérifie d'abord que
   * l'explorateur n'y a rien changé jusque-là, puis retient le nouvel état.
   */
  const alter = (change) => {
    try {
      intact = intact && snapshot(fixture.folder) === expected;
      change();
      expected = snapshot(fixture.folder);
      return true;
    } catch (error) {
      report.errors.push(`dossier d'essai de l'explorateur inutilisable : ${error?.message}`);
      return false;
    }
  };

  // Les éléments masqués sont affichés pendant le trajet : aucun dossier du chemin ne peut manquer.
  await act(toggleHidden);
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="pc"]').click();`);
  const steps = stepsTo(fixture.folder);
  let walked = await until(`${PAGE_TOOLS} return exContent().dataset.page === 'pc' || exState();`);
  for (const step of steps) {
    if (walked !== true) break;
    walked = await until(reach(step.path, `exOpen(${js(step.id)});`));
  }
  record(`navigation au double-clic, de « Ce PC » jusqu'au dossier d'essai (${steps.length} niveaux)`, walked);

  await check(
    "le dossier d'essai affiche son contenu réel (noms avec espaces, accents et apostrophe)",
    `${PAGE_TOOLS}
     const names = exNames();
     const crumbs = exCrumbs();
     return (exContent().dataset.path === ${js(fixture.folder)} && [...names].sort().join('|') === ${js([...VISIBLE_NAMES, REMOVED_NAME, fixture.hidden].sort().join('|'))}
       && exItems().filter((item) => item.classList.contains('is-dimmed')).map(exName).join('|') === ${js(fixture.hidden)}
       && crumbs[0] === 'Ce PC' && crumbs.at(-1) === ${js(FOLDER_NAME)}
       && exWin().querySelector('.window__title').textContent.startsWith(${js(FOLDER_NAME)})) || { names, crumbs, ...exState() };`,
  );

  // 4. Dossier supprimé alors que l'explorateur l'affiche encore : un message
  //    clair à l'ouverture, la navigation continue, et le dossier relu ne le cite plus.
  if (!alter(() => fs.rmdirSync(fixture.removed))) return;
  let vanished = await until(
    `${PAGE_TOOLS}
     const state = exState();
     if (state.page === 'folder' && state.path === ${js(fixture.folder)}) {
       // Revenu de la page d'erreur par « Précédent » : « Suivant » est disponible.
       if (exButton('Suivant').getAttribute('aria-disabled') === 'false') return true;
       if (!exBusy()) state.ouvert = exOpen(${js(fixture.removed)});
     } else if (state.page === 'error' && state.code === 'not-found' && state.message === 'Dossier introuvable'
       && exCrumbs().at(-1) === ${js(REMOVED_NAME)} && exItems().length === 0) {
       if (!exBusy()) exButton('Précédent').click();
     }
     return state;`,
  );
  if (vanished === true) {
    vanished = await until(
      `${PAGE_TOOLS}
       const names = exNames();
       return (exContent().dataset.path === ${js(fixture.folder)} && !exBusy() && names.length === ${VISIBLE_NAMES.length + 1}
         && !names.includes(${js(REMOVED_NAME)})) || { names, ...exState() };`,
    );
  }
  record('un dossier supprimé entre-temps affiche « Dossier introuvable », sans bloquer la navigation', vanished);

  // 5. Dossier inaccessible (Windows) : un message, et la navigation continue.
  if (isWindows) {
    const drive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive.toUpperCase() : 'C:';
    await checkProtectedFolder({ check, act, until, evaluate, report }, { drive, backTo: fixture.folder });
  }

  // 6. Éléments masqués : affichés à la demande seulement.
  await act(toggleHidden);
  await check(
    'les éléments masqués ne sont affichés que sur demande (menu Affichage)',
    `${PAGE_TOOLS}
     const names = exNames();
     return (exContent().dataset.path === ${js(fixture.folder)} && names.join('|') === ${js(VISIBLE_NAMES.join('|'))}
       && exStatus() === '5 éléments · 1 élément masqué') || { names, status: exStatus(), ...exState() };`,
  );

  // 7. Vue « Détails » : type, taille et date réels.
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-status [aria-label="Détails"]').click();`);
  await check(
    'vue « Détails » : type, taille et date de modification réels',
    `${PAGE_TOOLS}
     const cells = (name) => {
       const row = exItems().find((item) => exName(item) === name);
       return row ? [...row.querySelectorAll('.ex-row__cell')].map((cell) => cell.textContent.replace(/[\\u00a0\\u202f]/g, ' ')) : null;
     };
     const file = cells(${js(DETAILED_FILE.name)});
     const folder = cells(${js(VISIBLE_NAMES[0])});
     return (file !== null && folder !== null && file.join('|') === ${js([DETAILED_FILE.date, DETAILED_FILE.type, DETAILED_FILE.size].join('|'))}
       && folder[1] === 'Dossier de fichiers' && folder[2] === '' && /^\\d{2}\\/\\d{2}\\/\\d{4} \\d{2}:\\d{2}$/.test(folder[0])) || { file, folder };`,
  );
  await capture('06-explorateur');

  // 8. Sous-dossier, précédent, suivant, dossier parent.
  await act(`${PAGE_TOOLS} exOpen(${js(fixture.sub)});`);
  await check(
    "un sous-dossier s'ouvre au double-clic",
    `${PAGE_TOOLS}
     return (exContent().dataset.path === ${js(fixture.sub)} && exNames().join('|') === 'plage.jpg' && exCrumbs().at(-1) === ${js(VISIBLE_NAMES[0])}) || exState();`,
  );
  await act(`${PAGE_TOOLS} ${clickNav('Précédent')}`);
  await check('« Précédent » revient au dossier quitté', reach(fixture.folder, ''));
  await act(`${PAGE_TOOLS} ${clickNav('Suivant')}`);
  await check('« Suivant » retourne dans le sous-dossier', reach(fixture.sub, ''));
  await act(`${PAGE_TOOLS} ${clickNav('Dossier parent')}`);
  await check('« Dossier parent » remonte d’un niveau', reach(fixture.folder, ''));
  await act(`${PAGE_TOOLS} exOpen(${js(fixture.empty)});`);
  await check(
    'un dossier vide est annoncé comme tel',
    `${PAGE_TOOLS}
     return (exContent().dataset.path === ${js(fixture.empty)} && exItems().length === 0 && exMessage() === 'Ce dossier est vide'
       && exStatus() === '0 élément') || { status: exStatus(), ...exState() };`,
  );
  await act(`${PAGE_TOOLS} ${clickNav('Précédent')}`);
  await until(reach(fixture.folder, ''));

  // 9. Recherche dans le dossier affiché.
  await act(
    `${PAGE_TOOLS}
     const input = exWin().querySelector('.ex-filter input');
     input.value = 'RESUME ETE';
     input.dispatchEvent(new Event('input', { bubbles: true }));`,
  );
  await check(
    'la recherche filtre le dossier affiché, sans tenir compte de la casse ni des accents',
    `${PAGE_TOOLS}
     const names = exNames();
     return (names.join('|') === 'Résumé été.pdf' && exStatus() === '1 résultat · 1 élément masqué') || { names, status: exStatus() };`,
  );
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-filter [aria-label="Effacer la recherche"]').click();`);

  // 10. Actualiser : un fichier ajouté entre-temps apparaît.
  if (!alter(() => fs.writeFileSync(fixture.added, 'Fichier créé par l’auto-test après la première lecture du dossier.\n'))) return;
  await until(`${PAGE_TOOLS} return exNames().length === ${VISIBLE_NAMES.length} || exNames();`);
  await act(`${PAGE_TOOLS} ${clickNav('Actualiser')}`);
  await check(
    '« Actualiser » fait apparaître un fichier ajouté entre-temps',
    `${PAGE_TOOLS}
     const names = exNames();
     return (exContent().dataset.path === ${js(fixture.folder)} && names.length === ${VISIBLE_NAMES.length + 1}
       && names.includes(${js(ADDED_NAME)})) || { names, ...exState() };`,
  );

  // 11. Emplacements non disponibles : annoncés, jamais simulés.
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="network"]').click();`);
  await check(
    '« Réseau » et « Corbeille » sont annoncés comme non disponibles, sans contenu fictif',
    `${PAGE_TOOLS}
     const state = exState();
     if (state.page === 'info' && state.message === 'Réseau non disponible' && exItems().length === 0) {
       exWin().querySelector('.ex-side[data-id="trash"]').click();
     }
     return (state.page === 'info' && state.message === 'Corbeille non disponible' && exItems().length === 0) || state;`,
  );

  // 12. Le service refuse ce qui sort des emplacements autorisés…
  const outside =
    isWindows
      ? ['\\\\localhost\\C$', '\\\\?\\C:\\', '\\\\.\\C:\\', 'C:', 'C:Users', `${fixture.folder}:flux`, `${fixture.folder}\\NUL`]
      : ['relatif/dossier', './dossier', 'C:\\Windows'];
  const attempts = [
    ...outside.map((target) => [target, 'invalid-path']),
    ['..', 'invalid-path'],
    ['', 'invalid-path'],
    [`${fixture.folder}${path.sep}..${path.sep}..`, 'invalid-path'],
    [`${fixture.folder}${path.sep}.${path.sep}${VISIBLE_NAMES[0]}`, 'invalid-path'],
    [path.join(fixture.folder, 'Introuvable'), 'not-found'],
    [path.join(fixture.folder, DETAILED_FILE.name), 'not-a-directory'],
  ];
  await check(
    'le service de fichiers refuse les chemins relatifs, réseau ou spéciaux, et distingue dossier introuvable et fichier',
    `${PAGE_TOOLS}
     const wrong = [];
     for (const [target, expected] of ${js(attempts)}) {
       const reply = await files('list', target);
       if (reply.ok !== false || reply.code !== expected) wrong.push({ chemin: target, attendu: expected, obtenu: reply.ok ? 'accepté' : reply.code });
     }
     for (const value of [null, 42, {}, ['x']]) {
       const reply = await files('list', value);
       if (reply.ok !== false) wrong.push({ argument: String(value), obtenu: 'accepté' });
     }
     return wrong.length === 0 || wrong;`,
  );

  // 13. … et n'offre aucune opération d'écriture : ni dans ce qu'il annonce
  //     (inventaire des services, s'il est disponible), ni dans ce qu'il accepte.
  let declared = null;
  try {
    declared = describeServices ? (describeServices()?.files?.methods ?? []) : null;
  } catch {
    declared = null; // inventaire en panne : signalé ailleurs par un avertissement
  }
  const readOnlyService = declared === null || (Array.isArray(declared) && declared.join(',') === 'places,list');
  let refusedWrites;
  try {
    refusedWrites = await evaluate(
      `${PAGE_TOOLS}
       const accepted = [];
       for (const method of ${js(WRITE_METHODS)}) {
         const reply = await files(method, ${js(fixture.added)});
         if (reply.ok !== false || reply.code !== 'unknown-method') accepted.push({ method, obtenu: reply.ok ? 'accepté' : reply.code });
       }
       return accepted.length === 0 || accepted;`,
    );
  } catch (error) {
    refusedWrites = `exception : ${error?.message}`;
  }
  record(
    "le service de fichiers n'offre que la consultation : aucune opération d'écriture n'existe",
    (readOnlyService && refusedWrites === true) || { methodes: declared, demandes: refusedWrites },
  );

  // 14. Rien n'a changé dans le dossier parcouru.
  let unchanged;
  try {
    unchanged = intact && snapshot(fixture.folder) === expected;
  } catch (error) {
    unchanged = `lecture impossible : ${error?.message}`;
  }
  record("l'explorateur n'a rien modifié dans le dossier parcouru (contenu, tailles et dates identiques)", unchanged);

  // Pour la suite de l'auto-test (fenêtres) : retour à « Ce PC », en grandes icônes.
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-status [aria-label="Grandes icônes"]').click();`);
  await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="pc"]').click();`);
  await until(`${PAGE_TOOLS} return exContent().dataset.page === 'pc' || exState();`);
}

module.exports = { checkExplorer, checkProtectedFolder, createFixture, snapshot, stepsTo, FIXTURE_DIR, FOLDER_NAME, VISIBLE_NAMES, DETAILED_FILE, ADDED_NAME, REMOVED_NAME, WRITE_METHODS };
