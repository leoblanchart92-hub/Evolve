'use strict';

/**
 * Evolve — Auto-test : opérations réelles sur les fichiers.
 *
 * L'auto-test crée un « atelier » — un dossier d'essai à lui, dans son dossier
 * de sortie — puis y agit comme le ferait l'utilisateur, par les commandes de
 * l'explorateur et ses fenêtres de dialogue : nouveau dossier, coller devant
 * un nom déjà pris, renommer, couper, copier un dossier entier, envoyer à la
 * Corbeille, ouvrir un script. Après chaque opération, il relit lui-même le
 * disque et compare le contenu de l'atelier à ce que l'opération devait
 * produire : rien de plus, rien de moins. Sous Windows, il retrouve dans la
 * Corbeille le dossier qu'il y a envoyé, et constate que le script confirmé a
 * réellement été exécuté par Windows.
 *
 * Il présente ensuite à l'application, sans passer par l'interface, des
 * demandes qu'elle doit refuser : agir sans confirmation, remplacer un
 * élément, toucher à un lecteur, à un dossier personnel, à un dossier du
 * système ou à un lien, employer un nom ou un chemin interdit.
 *
 * Aucune de ces demandes ne peut nuire, même si l'application en acceptait une
 * par erreur. Celles qui visent un emplacement réel — dossier personnel,
 * dossier du système — ne font que le « renommer » sous le nom qu'il porte
 * déjà, ce qui ne change rien ; un lecteur ne peut pas être renommé. Toutes
 * les autres désignent un élément de l'atelier, ou rien : leur effet resterait
 * dans l'atelier, où le constat final le signalerait.
 *
 * Seul l'auto-test crée ces éléments d'essai, et uniquement dans son dossier
 * de sortie. Le dossier envoyé à la Corbeille y reste : Evolve ne supprime
 * rien définitivement, et l'auto-test ne le fait pas à sa place.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Dossier des opérations : son nom éprouve les espaces, les accents et l'apostrophe. */
const WORKSHOP_NAME = "Atelier d'essai été 2026";

/** Éléments de l'atelier : ceux que l'auto-test crée, puis ceux que les opérations doivent produire. */
const NAMES = Object.freeze({
  /** Fichier copié, puis collé là où un fichier du même nom existe déjà. */
  letter: 'Lettre à Zoé.txt',
  /** Dossier qui contient déjà une autre « Lettre à Zoé.txt » : elle ne doit jamais être remplacée. */
  photos: "Photos d'été",
  /** Fichier déplacé par « Couper » puis « Coller ». */
  picture: 'plage.jpg',
  /** Dossier envoyé à la Corbeille, avec son contenu. */
  discard: 'À jeter',
  draft: 'brouillon.txt',
  /** Script que l'explorateur n'ouvre qu'après confirmation. */
  script: 'Lancer.cmd',
  /** Fichier que le script crée à côté de lui quand Windows l'exécute. */
  marker: 'script-execute.txt',
  /** Lien vers le dossier parcouru : aucune opération ne s'applique à un lien. */
  link: 'Lien vers le dossier parcouru',
  /** Dossier créé par « Nouveau dossier ». */
  created: "Reçus d'août",
  /** Copie conservée à côté d'un élément du même nom (« Conserver les deux »). */
  kept: 'Lettre à Zoé - Copie.txt',
  /** Nom donné à cette copie par « Renommer ». */
  renamed: 'Lettre relue.txt',
});

/** Intitulés des contrôles, dans l'ordre du scénario. */
const CHECKS = Object.freeze({
  create: '« Nouveau dossier » : un nom réservé par Windows est refusé, puis le dossier est réellement créé sous le nom saisi',
  collision: "« Coller » devant un nom déjà pris : rien n'est remplacé — « Ignorer » ne change rien, « Conserver les deux » crée une copie sous un autre nom",
  rename: "« Renommer » : un nom déjà pris est refusé, puis l'élément change réellement de nom, contenu intact",
  move: "« Couper » puis « Coller » : rien ne bouge sans confirmation ; confirmé, l'élément est réellement déplacé",
  copy: '« Copier » puis « Coller » : un fichier et un dossier entier sont réellement copiés, les originaux sont intacts',
  trash: '« Envoyer à la Corbeille » : rien ne bouge sans confirmation ; confirmé, le dossier quitte son emplacement',
  recycled: "le dossier envoyé à la Corbeille se trouve dans la Corbeille de Windows, intact : rien n'est supprimé définitivement",
  open: "ouvrir un script demande une confirmation, « Annuler » par défaut ; sans elle, rien n'est exécuté",
  executed: "après confirmation, Windows exécute le script : le fichier est ouvert avec l'application associée",
  unconfirmed: 'sans confirmation, déplacer, envoyer à la Corbeille et exécuter sont refusés ; remplacer un élément est impossible',
  refused: 'lecteurs, dossiers personnels, dossiers du système et liens sont refusés par les opérations ; les noms et les chemins interdits aussi',
  state: "l'atelier contient exactement ce que les opérations demandées devaient produire : rien de plus, rien de moins",
});

/** Dans un contenu attendu : un dossier, un lien, ou un fichier dont le contenu importe peu. */
const DIRECTORY = 'dossier';
const LINK = 'lien';
const ANY_FILE = 'fichier';

const js = (value) => JSON.stringify(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Crée l'atelier dans le dossier `run` de l'essai.
 * @param {string} run  dossier de l'essai (chemin réel)
 * @param {object} [options]
 * @param {string} [options.linkTarget]  dossier vers lequel mène le lien d'essai
 * @returns {{ folder: string, link: string|null }} chemins réels ; `link` vaut `null` si le lien n'a pas pu être créé
 */
function createWorkshop(run, { linkTarget = null } = {}) {
  const folder = path.join(run, WORKSHOP_NAME);
  const at = (...names) => path.join(folder, ...names);
  fs.mkdirSync(at(NAMES.photos), { recursive: true });
  fs.mkdirSync(at(NAMES.discard));
  fs.writeFileSync(at(NAMES.letter), 'Chère Zoé,\r\nvoici la lettre que l’auto-test copie.\r\n');
  fs.writeFileSync(at(NAMES.photos, NAMES.letter), 'Autre lettre, déjà rangée ici : elle ne doit jamais être remplacée.\r\n');
  fs.writeFileSync(at(NAMES.photos, NAMES.picture), Buffer.alloc(3072, 5));
  fs.writeFileSync(at(NAMES.discard, NAMES.draft), 'Brouillon à jeter.\r\n');
  // Exécuté par Windows, le script laisse un fichier témoin à côté de lui. Son texte n'emploie
  // que des caractères ASCII : l'interpréteur de commandes le lit quelle que soit la page de codes.
  fs.writeFileSync(at(NAMES.script), `@echo off\r\n> "%~dp0${NAMES.marker}" echo execute\r\n`);
  let link = null;
  if (linkTarget) {
    try {
      // Jonction sous Windows (aucun droit particulier n'est nécessaire), lien symbolique ailleurs.
      fs.symlinkSync(linkTarget, at(NAMES.link), 'junction');
      link = at(NAMES.link);
    } catch {
      link = null;
    }
  }
  return { folder, link };
}

/**
 * Contenu réel d'un dossier : pour chaque élément, désigné par son chemin
 * relatif (séparé par « / »), sa nature — dossier, lien — ou l'empreinte de
 * son contenu. Les liens ne sont pas suivis.
 */
function contentOf(folder) {
  const found = {};
  (function walk(current, prefix) {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const key = prefix ? `${prefix}/${name}` : name;
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) {
        found[key] = LINK;
      } else if (info.isDirectory()) {
        found[key] = DIRECTORY;
        walk(full, key);
      } else {
        found[key] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  })(folder, '');
  return found;
}

/**
 * Écarts entre un contenu attendu et un contenu réel (voir `contentOf`), ou
 * `null` s'ils sont identiques.
 * @returns {{ manquants: string[], inattendus: string[], modifies: string[] } | null}
 */
function differences(expected, found) {
  const same = (key) => expected[key] === found[key] || (expected[key] === ANY_FILE && found[key] !== DIRECTORY && found[key] !== LINK);
  const missing = Object.keys(expected).filter((key) => !Object.hasOwn(found, key));
  const unexpected = Object.keys(found).filter((key) => !Object.hasOwn(expected, key));
  const changed = Object.keys(expected).filter((key) => Object.hasOwn(found, key) && !same(key));
  return missing.length || unexpected.length || changed.length ? { manquants: missing, inattendus: unexpected, modifies: changed } : null;
}

/**
 * Emplacement d'origine inscrit dans une fiche « $I… » de la Corbeille de
 * Windows : 8 octets de version, 8 de taille, 8 de date, puis le chemin en
 * UTF-16 — précédé de sa longueur depuis Windows 10 (version 2), de longueur
 * fixe auparavant (version 1).
 */
function recycledPathOf(record) {
  if (!Buffer.isBuffer(record) || record.length < 28) return null;
  const version = record.readBigInt64LE(0);
  let bytes;
  if (version === 1n) bytes = record.subarray(24, 24 + 520);
  else if (version >= 2n && version < 16n) bytes = record.subarray(28, 28 + record.readUInt32LE(24) * 2);
  else return null;
  const text = bytes.toString('utf16le');
  const end = text.indexOf('\0');
  return end < 0 ? text : text.slice(0, end);
}

/**
 * Cherche dans la Corbeille de Windows d'un lecteur (`binDir` :
 * « X:\$RECYCLE.BIN ») l'élément qui se trouvait à `original`. Windows y range
 * chaque élément sous deux noms, dans le dossier du compte : « $I… », la fiche
 * (emplacement d'origine, date), et « $R… », l'élément lui-même.
 * @returns {{ record: string, content: string|null } | null} la fiche et l'élément, ou `null` s'il n'y est pas
 */
function findRecycled(binDir, original) {
  const wanted = original.toLowerCase();
  let owners;
  try {
    owners = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const owner of owners) {
    if (!owner.isDirectory()) continue;
    const folder = path.join(binDir, owner.name);
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue; // Corbeille d'un autre compte : Windows n'en autorise pas la lecture
    }
    for (const name of names) {
      if (!/^\$I/i.test(name)) continue;
      let recorded;
      try {
        recorded = recycledPathOf(fs.readFileSync(path.join(folder, name)));
      } catch {
        continue;
      }
      if (recorded === null || recorded.toLowerCase() !== wanted) continue;
      const content = path.join(folder, `$R${name.slice(2)}`);
      return { record: path.join(folder, name), content: fs.existsSync(content) ? content : null };
    }
  }
  return null;
}

/**
 * Outils exécutés dans la page, en plus de ceux de l'explorateur (`pageTools`) :
 * commandes, sélection, presse-papiers, fenêtre de dialogue, notification.
 */
const operationTools = (pageTools) => `${pageTools}
  const exCommand = (name) => exWin().querySelector('.ex-commands [data-command="' + name + '"]');
  const exCan = (name) => exCommand(name).getAttribute('aria-disabled') === 'false';
  const exItem = (name) => exItems().find((item) => exName(item) === name) ?? null;
  const exSelected = () => exItems().filter((item) => item.classList.contains('is-selected')).map(exName).sort();
  const exSelect = (...names) => names.forEach((name, index) => exItem(name).dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: index > 0 })));
  const exChip = () => {
    const chip = exWin().querySelector('.ex-status__clipboard');
    return chip.hidden ? null : chip.textContent;
  };
  const dialog = () => document.querySelector('.dialog-backdrop:not(.is-closing) .dialog');
  const dialogState = () => {
    const el = dialog();
    if (!el) return null;
    const input = el.querySelector('.dialog__input');
    return { kind: el.dataset.kind, title: el.querySelector('.dialog__title').textContent, busy: el.getAttribute('aria-busy') === 'true',
      value: input ? input.value : null, error: el.querySelector('.dialog__error')?.textContent ?? '' };
  };
  const dialogIs = (kind, title) => {
    const state = dialogState();
    return state !== null && state.kind === kind && state.title === title && !state.busy;
  };
  const dialogType = (text) => {
    const input = dialog().querySelector('.dialog__input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const dialogPress = (action) => dialog().querySelector('.dialog__button[data-action="' + action + '"]').click();
  const toastTitles = () => [...document.querySelectorAll('.toast:not(.is-leaving) .toast__title')].map((title) => title.textContent);
  const exIdle = () => dialog() === null && !exBusy() && exCan('new-folder');
  const observed = () => ({ dialogue: dialogState(), notifications: toastTitles(), selection: exSelected(), 'presse-papiers': exChip(), ...exState() });
`;

/**
 * Contrôles des opérations sur les fichiers.
 * @param {object} tools  outils de l'auto-test (voir selftest.js) : `evaluate`, `until`, `record`, `capture`, `report`, `timings`
 * @param {object} context
 * @param {string} context.pageTools  outils de l'explorateur exécutés dans la page (voir selftest-explorer.js)
 * @param {{ folder: string, link: string|null }} context.workshop  l'atelier (voir `createWorkshop`)
 * @param {string} [context.platform]  système sur lequel l'application s'exécute
 * @param {object} [context.env]       variables d'environnement de ce système
 * @param {string|null} [context.recycleBin]  dossier de la Corbeille du lecteur de l'atelier ; `null` : elle n'est pas examinée
 * @returns {{ operate(): Promise<void>, refuse(): Promise<void>, conclude(): void }}
 */
function operationChecks({ evaluate, until, record, capture, report, timings }, { pageTools, workshop, platform = process.platform, env = process.env, recycleBin }) {
  const isWindows = platform === 'win32';
  const tools = operationTools(pageTools);
  const N = NAMES;
  const work = workshop.folder;
  const at = (...names) => path.join(work, ...names);
  /** Corbeille examinée : celle du lecteur de l'atelier, sous Windows. */
  const bin = recycleBin === undefined ? (isWindows ? path.join(path.parse(work).root, '$RECYCLE.BIN') : null) : recycleBin;

  /** Contenu que l'atelier doit avoir : celui que l'auto-test a créé, puis l'effet de chaque opération aboutie. */
  const expected = contentOf(work);
  /** Raison pour laquelle les opérations suivantes ne sont pas menées : chacune part de l'état laissé par la précédente. */
  let stopped = null;

  /** Compare l'atelier, sur le disque, au contenu attendu : `true`, ou les écarts. */
  const disk = () => {
    try {
      return differences(expected, contentOf(work)) ?? true;
    } catch (error) {
      return { lecture: `impossible : ${error?.message}` };
    }
  };

  /**
   * Mène une suite de gestes dans l'interface : chaque étape agit, puis attend
   * l'état qui doit en résulter. Renvoie `true`, ou ce qui a été observé à
   * l'étape qui n'a pas abouti.
   * @param {[string, string, string][]} steps  intitulé, geste (code de page), état attendu (expression de page)
   */
  const gestures = async (steps) => {
    for (const [label, action, state] of steps) {
      try {
        await evaluate(`${tools} ${action}`);
      } catch (error) {
        return { etape: label, geste: `impossible : ${error?.message}` };
      }
      const seen = await until(`${tools} return (${state}) || observed();`);
      if (seen !== true) return { etape: label, obtenu: seen ?? null };
    }
    return true;
  };

  /** Après une étape qui ne doit rien changer : l'atelier est resté tel quel. */
  const untouched = (label) => {
    const state = disk();
    return state === true || { etape: label, disque: state };
  };

  /** Une opération menée dans l'interface, puis contrôlée sur le disque. */
  const operation = async (name, run) => {
    if (stopped) {
      record(name, { 'non mené': stopped });
      return;
    }
    let result;
    try {
      result = await run();
    } catch (error) {
      result = { exception: error?.message };
    }
    if (result !== true) {
      stopped = `l'opération précédente n'a pas abouti (${name.split(' : ')[0]})`;
      // Une fenêtre de dialogue restée ouverte ne doit pas gêner la suite de l'auto-test.
      try {
        await evaluate(`${tools} dialog()?.querySelector('[data-action="cancel"], [data-action="close"]')?.click();`);
      } catch {
        /* la page ne répond plus : signalé par les contrôles suivants */
      }
    }
    record(name, result);
  };

  // Expressions de page : états attendus.
  const shows = (folder) => `exContent().dataset.path === ${js(folder)} && !exBusy()`;
  const selected = (...names) => `exSelected().join('|') === ${js([...names].sort().join('|'))}`;
  const has = (name) => `exItem(${js(name)}) !== null`;
  const lacks = (name) => `exItem(${js(name)}) === null`;
  const asks = (kind, title) => `dialogIs(${js(kind)}, ${js(title)})`;
  // L'opération est terminée — les commandes sont de nouveau utilisables — et l'explorateur l'a annoncée.
  const finished = (toast) => `exIdle() && toastTitles().includes(${js(toast)})`;
  // Gestes.
  const command = (name) => `exCommand(${js(name)}).click();`;
  const select = (...names) => `exSelect(${names.map(js).join(', ')});`;
  const open = (location) => `exOpen(${js(location)});`;
  const type = (text) => `dialogType(${js(text)}); dialogPress("confirm");`;
  const press = (action) => `dialogPress(${js(action)});`;
  const goUp = `exButton("Dossier parent").click();`;

  /** Opérations menées dans l'interface. L'explorateur affiche le dossier de l'essai, qui contient l'atelier. */
  async function operate() {
    // Nouveau dossier : le nom est contrôlé par l'application de bureau, son refus s'affiche sous le champ.
    await operation(CHECKS.create, async () => {
      const shown = await gestures([
        ["ouvrir l'atelier", open(work), `${shows(work)} && exCan('new-folder')`],
        ['commande « Nouveau dossier »', command('new-folder'), `${asks('prompt', 'Nouveau dossier')} && dialogState().value === 'Nouveau dossier'`],
        ['saisir un nom réservé par Windows', type('CON'), `${asks('prompt', 'Nouveau dossier')} && /réservé par Windows/.test(dialogState().error)`],
        ['saisir le nom du dossier', type(N.created), `${finished('Dossier créé')} && ${selected(N.created)}`],
      ]);
      if (shown !== true) return shown;
      expected[N.created] = DIRECTORY;
      return disk();
    });

    // Nom déjà pris : la lettre est collée là où une autre lettre porte son nom.
    await operation(CHECKS.collision, async () => {
      const question = asks('choose', `« ${N.letter} » existe déjà`);
      let shown = await gestures([
        ['sélectionner la lettre', select(N.letter), `${selected(N.letter)} && exCan('copy')`],
        ['commande « Copier »', command('copy'), `exChip() === '1 élément à coller' && exCan('paste')`],
        ['ouvrir le dossier des photos', open(at(N.photos)), `${shows(at(N.photos))} && exCan('paste')`],
        ['commande « Coller »', command('paste'), question],
      ]);
      if (shown !== true) return shown;
      await capture('07-nom-deja-pris');
      shown = await gestures([['réponse « Ignorer »', press('skip'), `${finished('Aucun élément copié')} && ${lacks(N.kept)}`]]);
      if (shown !== true) return shown;
      const ignored = untouched('réponse « Ignorer »');
      if (ignored !== true) return ignored;
      shown = await gestures([
        ['commande « Coller », de nouveau', command('paste'), question],
        ['réponse « Conserver les deux »', press('keep-both'), `${finished('Copie terminée')} && ${selected(N.kept)}`],
      ]);
      if (shown !== true) return shown;
      // L'autre lettre est intacte : son empreinte, dans le contenu attendu, n'a pas changé.
      expected[`${N.photos}/${N.kept}`] = expected[N.letter];
      return disk();
    });

    // Renommer : la copie reçoit un autre nom ; celui d'un élément voisin est refusé.
    await operation(CHECKS.rename, async () => {
      const shown = await gestures([
        ['sélectionner la copie', select(N.kept), `${selected(N.kept)} && exCan('rename')`],
        ['commande « Renommer »', command('rename'), `${asks('prompt', 'Renommer')} && dialogState().value === ${js(N.kept)}`],
        ['saisir un nom déjà pris', type(N.picture), `${asks('prompt', 'Renommer')} && /Rien n’a été remplacé/.test(dialogState().error)`],
        ['saisir le nouveau nom', type(N.renamed), `${finished('Élément renommé')} && ${selected(N.renamed)} && ${lacks(N.kept)}`],
      ]);
      if (shown !== true) return shown;
      expected[`${N.photos}/${N.renamed}`] = expected[`${N.photos}/${N.kept}`];
      delete expected[`${N.photos}/${N.kept}`];
      return disk();
    });

    // Couper, puis coller dans le nouveau dossier : un déplacement, confirmé.
    await operation(CHECKS.move, async () => {
      const question = asks('confirm', `Déplacer « ${N.picture} » ?`);
      let shown = await gestures([
        ['sélectionner la photo', select(N.picture), `${selected(N.picture)} && exCan('cut')`],
        ['commande « Couper »', command('cut'), `exChip() === '1 élément à déplacer' && exItem(${js(N.picture)}).classList.contains('is-cut') && exCan('paste')`],
        ["revenir à l'atelier", goUp, shows(work)],
        ['ouvrir le nouveau dossier', open(at(N.created)), `${shows(at(N.created))} && exCan('paste')`],
        ['commande « Coller »', command('paste'), question],
        ['réponse « Annuler »', press('cancel'), `exIdle() && ${lacks(N.picture)} && exCan('paste')`],
      ]);
      if (shown !== true) return shown;
      const cancelled = untouched('réponse « Annuler »');
      if (cancelled !== true) return cancelled;
      shown = await gestures([
        ['commande « Coller », de nouveau', command('paste'), question],
        ['réponse « Déplacer »', press('confirm'), `${finished('Déplacement terminé')} && ${selected(N.picture)} && exChip() === null && !exCan('paste')`],
      ]);
      if (shown !== true) return shown;
      expected[`${N.created}/${N.picture}`] = expected[`${N.photos}/${N.picture}`];
      delete expected[`${N.photos}/${N.picture}`];
      return disk();
    });

    // Copier un fichier et un dossier entier, puis les coller dans le nouveau dossier.
    await operation(CHECKS.copy, async () => {
      const shown = await gestures([
        ["revenir à l'atelier", goUp, shows(work)],
        ['sélectionner la lettre et le dossier des photos', select(N.letter, N.photos), `${selected(N.letter, N.photos)} && exCan('copy')`],
        ['commande « Copier »', command('copy'), `exChip() === '2 éléments à coller' && exCan('paste')`],
        ['ouvrir le nouveau dossier', open(at(N.created)), `${shows(at(N.created))} && exCan('paste')`],
        ['commande « Coller »', command('paste'), `${finished('Copie terminée')} && ${selected(N.letter, N.photos)} && ${has(N.picture)}`],
      ]);
      if (shown !== true) return shown;
      for (const [key, value] of Object.entries(expected)) {
        if (key === N.letter || key === N.photos || key.startsWith(`${N.photos}/`)) expected[`${N.created}/${key}`] = value;
      }
      return disk();
    });

    // Envoyer un dossier à la Corbeille.
    const discarded = at(N.discard);
    /** Contenu du dossier, relevé avant son envoi : celui que la Corbeille doit avoir reçu. */
    let discardedContent = null;
    await operation(CHECKS.trash, async () => {
      const question = `${asks('confirm', `Envoyer « ${N.discard} » à la Corbeille ?`)} && dialog().dataset.tone === 'danger'`;
      let shown = await gestures([
        ["revenir à l'atelier", goUp, shows(work)],
        ['sélectionner le dossier à jeter', select(N.discard), `${selected(N.discard)} && exCan('delete')`],
        ['commande « Envoyer à la Corbeille »', command('delete'), question],
      ]);
      if (shown !== true) return shown;
      await capture('08-corbeille');
      shown = await gestures([['réponse « Annuler »', press('cancel'), `exIdle() && ${has(N.discard)}`]]);
      if (shown !== true) return shown;
      const cancelled = untouched('réponse « Annuler »');
      if (cancelled !== true) return cancelled;
      discardedContent = contentOf(discarded);
      shown = await gestures([
        ['commande « Envoyer à la Corbeille », de nouveau', `${select(N.discard)} ${command('delete')}`, question],
        ['réponse « Envoyer à la Corbeille »', press('confirm'), `${finished('Envoyé à la Corbeille')} && ${lacks(N.discard)}`],
      ]);
      if (shown !== true) return shown;
      for (const key of Object.keys(expected)) {
        if (key === N.discard || key.startsWith(`${N.discard}/`)) delete expected[key];
      }
      return disk();
    });

    // Le dossier n'a pas été supprimé : il est dans la Corbeille de Windows, avec son contenu.
    if (bin) {
      if (stopped) {
        record(CHECKS.recycled, { 'non mené': stopped });
      } else {
        const deadline = Date.now() + timings.check;
        let found = findRecycled(bin, discarded);
        while (!found && Date.now() < deadline) {
          await sleep(timings.poll);
          found = findRecycled(bin, discarded);
        }
        let result;
        if (!found) result = { corbeille: bin, 'élément recherché': discarded, 'trouvé': false };
        else if (!found.content) result = { fiche: found.record, 'élément': 'absent de la Corbeille' };
        else {
          try {
            result = differences(discardedContent, contentOf(found.content)) ?? true;
          } catch (error) {
            result = { fiche: found.record, lecture: `impossible : ${error?.message}` };
          }
        }
        // Pour le compte rendu : où Windows a rangé le dossier.
        if (result === true) report.recycled = { from: discarded, record: found.record, content: found.content };
        record(CHECKS.recycled, result);
      }
    }

    // Ouvrir un script : rien n'est confié à Windows sans confirmation, et « Annuler » a le clavier.
    const scriptQuestion = asks('confirm', `Ouvrir « ${N.script} » ?`);
    await operation(CHECKS.open, async () => {
      const shown = await gestures([
        ['double-clic sur le script', open(at(N.script)), `${scriptQuestion} && document.activeElement === dialog().querySelector('[data-action="cancel"]')`],
        ['réponse « Annuler »', press('cancel'), 'exIdle()'],
      ]);
      return shown === true ? untouched('réponse « Annuler »') : shown;
    });

    // Sous Windows seulement : confirmé, le script est exécuté par Windows, qui laisse le fichier témoin.
    if (isWindows) {
      await operation(CHECKS.executed, async () => {
        const shown = await gestures([
          ['double-clic sur le script', open(at(N.script)), scriptQuestion],
          ['réponse « Ouvrir »', press('confirm'), `exIdle() && !toastTitles().some((title) => title.startsWith('Ouverture impossible'))`],
        ]);
        if (shown !== true) return shown;
        const deadline = Date.now() + timings.response;
        while (!fs.existsSync(at(N.marker)) && Date.now() < deadline) await sleep(timings.poll);
        if (!fs.existsSync(at(N.marker))) return { 'fichier témoin': 'absent', attendu: at(N.marker) };
        expected[N.marker] = ANY_FILE;
        return disk();
      });
    }
  }

  /**
   * Demandes présentées directement à l'application de bureau, sans passer par
   * l'interface : chacune doit être refusée, avec le code attendu.
   */
  async function refuse() {
    const sep = path.sep;
    const letter = at(N.letter);
    const photos = at(N.photos);
    const script = at(N.script);
    const absent = at('Absent.txt');
    const CONFIRMED = '{ confirmed: true }';
    /** Code de page : la demande `call` doit être refusée avec le code `code`. */
    const refusal = (label, call, code) => `await refusal(${js(label)}, () => ${call}, ${js(code)});`;
    /** Code de page : la demande `call` doit seulement signaler un nom déjà pris, sans rien faire. */
    const question = (label, call) => `await question(${js(label)}, () => ${call});`;
    const page = (lines) => `${tools}
      const ops = window.evolve.files;
      const wrong = [];
      const outcome = (reply) => (reply?.ok === true ? (reply.value?.status === 'collisions' ? 'question posée' : 'accepté') : (reply?.code ?? null));
      const ask = async (send) => {
        try {
          return await send();
        } catch (error) {
          return { ok: false, code: 'exception : ' + error?.message };
        }
      };
      const refusal = async (label, send, code) => {
        const reply = await ask(send);
        if (reply?.ok !== false || reply.code !== code) wrong.push({ demande: label, attendu: code, obtenu: outcome(reply) });
      };
      const question = async (label, send) => {
        const reply = await ask(send);
        if (reply?.ok !== true || reply.value?.status !== 'collisions') wrong.push({ demande: label, attendu: 'question posée', obtenu: outcome(reply) });
      };
      ${lines.join('\n      ')}
      return wrong.length === 0 || wrong;`;
    const run = async (lines) => {
      try {
        return await evaluate(page(lines));
      } catch (error) {
        return `exception : ${error?.message}`;
      }
    };

    // Sans confirmation ; remplacer.
    const unconfirmed = await run([
      refusal('envoyer à la Corbeille, sans confirmation', `ops.trash([${js(letter)}])`, 'needs-confirmation'),
      refusal('envoyer à la Corbeille, confirmation refusée', `ops.trash([${js(letter)}], { confirmed: false })`, 'needs-confirmation'),
      refusal('déplacer, sans confirmation', `ops.move([${js(letter)}], ${js(photos)})`, 'needs-confirmation'),
      refusal('déplacer, confirmation refusée', `ops.move([${js(letter)}], ${js(photos)}, { confirmed: false })`, 'needs-confirmation'),
      refusal('ouvrir un script, sans confirmation', `ops.open(${js(script)})`, 'needs-confirmation'),
      refusal('ouvrir un script, confirmation refusée', `ops.open(${js(script)}, { confirmed: false })`, 'needs-confirmation'),
      refusal('copier en remplaçant', `ops.copy([${js(letter)}], ${js(photos)}, { onCollision: 'replace' })`, 'bad-arguments'),
      refusal('copier en écrasant', `ops.copy([${js(letter)}], ${js(photos)}, { overwrite: true })`, 'bad-arguments'),
      refusal('déplacer en remplaçant', `ops.move([${js(letter)}], ${js(photos)}, { confirmed: true, onCollision: 'replace' })`, 'bad-arguments'),
      refusal('supprimer définitivement', `ops.trash([${js(letter)}], { confirmed: true, permanent: true })`, 'bad-arguments'),
      refusal("renommer sous le nom d'un élément voisin", `ops.rename(${js(letter)}, ${js(N.script)})`, 'collision'),
      refusal('créer un dossier dont le nom est pris', `ops.createFolder(${js(work)}, ${js(N.photos)})`, 'collision'),
      question('copier devant un nom déjà pris', `ops.copy([${js(letter)}], ${js(photos)})`),
      question('déplacer devant un nom déjà pris', `ops.move([${js(letter)}], ${js(photos)}, ${CONFIRMED})`),
    ]);
    record(CHECKS.unconfirmed, unconfirmed);

    // Emplacements, liens, chemins et noms.
    const { root } = path.parse(work);
    // Chemins interdits qui ne peuvent désigner que l'atelier. Le premier remonte d'un dossier puis y revient ;
    // le second est relatif : il commence par le nom, tiré au hasard, du dossier de cet essai, et ne désigne
    // donc rien, où que l'application ait été lancée — sinon l'atelier lui-même.
    const climbing = `${work}${sep}..${sep}${WORKSHOP_NAME}`;
    const relative = `${path.basename(path.dirname(work))}${sep}${WORKSHOP_NAME}`;
    const lines = [
      // Un lecteur : il ne peut pas être renommé, même si la demande était acceptée.
      refusal('renommer un lecteur', `ops.rename(${js(root)}, 'Evolve')`, 'protected'),
      // Chaque dossier personnel : « renommé » sous son propre nom, la demande est sans effet même si elle était acceptée.
      `for (const place of (await files('places')).value.places.filter((item) => item.available && typeof item.path === 'string')) {
        const parts = place.path.split(/[\\\\/]/).filter(Boolean);
        if (parts.length < 2) continue; // un lecteur entier : déjà contrôlé
        await refusal('renommer le dossier personnel ' + place.id, () => ops.rename(place.path, parts.pop()), 'protected');
      }`,
      // Chemins qui remontent.
      refusal('créer un dossier par un chemin qui remonte', `ops.createFolder(${js(climbing)}, 'Evolve')`, 'invalid-path'),
      refusal('renommer par un chemin qui remonte', `ops.rename(${js(`${climbing}${sep}${N.letter}`)}, 'x.txt')`, 'invalid-path'),
      refusal('envoyer à la Corbeille par un chemin qui remonte', `ops.trash([${js(`${climbing}${sep}${N.letter}`)}], ${CONFIRMED})`, 'invalid-path'),
      // Chemins relatifs, chemin vide.
      refusal('renommer par un chemin relatif', `ops.rename(${js(`${relative}${sep}${N.letter}`)}, 'x.txt')`, 'invalid-path'),
      refusal('envoyer à la Corbeille par un chemin relatif', `ops.trash([${js(`${relative}${sep}${N.letter}`)}], ${CONFIRMED})`, 'invalid-path'),
      refusal('copier vers un chemin relatif', `ops.copy([${js(letter)}], ${js(relative)})`, 'invalid-path'),
      refusal('déplacer depuis un chemin relatif', `ops.move([${js(`${relative}${sep}${N.letter}`)}], ${js(photos)}, ${CONFIRMED})`, 'invalid-path'),
      refusal('ouvrir un chemin vide', `ops.open('')`, 'invalid-path'),
      // Noms que Windows n'admet pas.
      ...['CON', 'nul.txt', 'COM1', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', '..', '.', 'fin.', 'fin ', ' debut', '', '   '].map((name) =>
        refusal(`créer le dossier ${js(name)}`, `ops.createFolder(${js(work)}, ${js(name)})`, 'invalid-name'),
      ),
      refusal('renommer en « LPT1.txt »', `ops.rename(${js(letter)}, 'LPT1.txt')`, 'invalid-name'),
      // Un dossier dans lui-même.
      refusal('copier un dossier dans lui-même', `ops.copy([${js(photos)}], ${js(photos)})`, 'into-itself'),
      refusal('déplacer un dossier dans lui-même', `ops.move([${js(photos)}], ${js(photos)}, ${CONFIRMED})`, 'into-itself'),
      // Éléments absents, ou d'une autre nature.
      refusal('renommer un élément absent', `ops.rename(${js(absent)}, 'x.txt')`, 'not-found'),
      refusal('ouvrir un élément absent', `ops.open(${js(absent)})`, 'not-found'),
      refusal('ouvrir un dossier comme un fichier', `ops.open(${js(photos)})`, 'not-a-file'),
      refusal('créer un dossier dans un fichier', `ops.createFolder(${js(letter)}, 'Evolve')`, 'not-a-directory'),
      // Demandes mal formées.
      refusal('demande sans argument', `ops.createFolder()`, 'bad-arguments'),
      refusal('liste remplacée par un texte', `ops.trash(${js(letter)}, ${CONFIRMED})`, 'bad-arguments'),
      refusal('liste vide', `ops.copy([], ${js(work)})`, 'bad-arguments'),
      refusal('choix inattendus', `ops.copy([${js(letter)}], ${js(work)}, 'oui')`, 'bad-arguments'),
    ];
    if (workshop.link) {
      const link = workshop.link;
      lines.push(
        refusal('renommer un lien', `ops.rename(${js(link)}, 'Autre lien')`, 'link-not-supported'),
        refusal('envoyer un lien à la Corbeille', `ops.trash([${js(link)}], ${CONFIRMED})`, 'link-not-supported'),
        refusal('copier un lien', `ops.copy([${js(link)}], ${js(photos)})`, 'link-not-supported'),
        refusal('déplacer un lien', `ops.move([${js(link)}], ${js(photos)}, ${CONFIRMED})`, 'link-not-supported'),
        refusal('ouvrir un lien comme un fichier', `ops.open(${js(link)})`, 'link-not-supported'),
      );
    } else {
      report.warnings.push("lien d'essai impossible à créer sur cette machine : le refus des opérations sur les liens n'a pas été vérifié");
    }
    if (isWindows) {
      // Formes de chemin propres à Windows. Chacune désigne la lettre de l'atelier, ou rien : par le partage
      // réseau de son lecteur, par un espace de noms, par un flux, par un chemin relatif à un lecteur, et
      // enfin un nom de périphérique.
      const lettered = /^[A-Za-z]:/.test(root);
      const viaNetwork = `\\\\localhost\\${lettered ? root[0] : 'C'}$\\${path.relative(root, letter)}`;
      const viaDrive = `${lettered ? root.slice(0, 2) : 'C:'}${relative}${sep}${N.letter}`;
      lines.push(
        refusal('renommer par un chemin réseau', `ops.rename(${js(viaNetwork)}, 'x.txt')`, 'invalid-path'),
        refusal('renommer par un espace de noms', `ops.rename(${js(`\\\\?\\${letter}`)}, 'x.txt')`, 'invalid-path'),
        refusal("envoyer un flux à la Corbeille", `ops.trash([${js(`${letter}:flux`)}], ${CONFIRMED})`, 'invalid-path'),
        refusal('renommer par un chemin relatif à un lecteur', `ops.rename(${js(viaDrive)}, 'x.txt')`, 'invalid-path'),
        refusal('ouvrir un périphérique', `ops.open(${js(`${work}\\NUL`)})`, 'invalid-path'),
      );
      // Dossiers du système, désignés par leur nom réel : « renommés » sous ce même nom, sans effet possible.
      for (const name of ['SystemRoot', 'ProgramFiles', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']) {
        let real;
        try {
          real = fs.realpathSync.native(env[name]);
        } catch {
          continue; // variable absente ou dossier introuvable sur cette machine
        }
        lines.push(refusal(`renommer le dossier du système %${name}%`, `ops.rename(${js(real)}, ${js(path.basename(real))})`, 'protected'));
      }
    }
    record(CHECKS.refused, await run(lines));
  }

  /** Constat final : aucune des demandes refusées n'a laissé de trace, et chaque opération menée a eu exactement son effet. */
  function conclude() {
    record(CHECKS.state, disk());
  }

  return { operate, refuse, conclude };
}

module.exports = { operationChecks, createWorkshop, contentOf, differences, findRecycled, recycledPathOf, operationTools, WORKSHOP_NAME, NAMES, CHECKS, DIRECTORY, LINK, ANY_FILE };
