/**
 * Opérations sur les fichiers de l'explorateur, côté interface
 * (apps/explorer-actions.js, core/file-operations.js) : commandes utilisables,
 * presse-papiers interne, questions posées à l'utilisateur, comptes rendus.
 *
 * Modules sans DOM : les fenêtres de dialogue, les notifications et
 * l'application de bureau sont remplacées par de faux objets, qui consignent
 * tout ce qui leur est demandé. L'enchaînement complet jusqu'au disque est
 * éprouvé par tests/main-process.test.mjs et par l'auto-test de l'exécutable.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FileActions,
  MAX_ITEMS,
  availableCommands,
  baseLength,
  createFileClipboard,
  describeReport,
  folderOf,
  freeFolderName,
  isOperable,
  listNames,
  newOperationId,
} from '../src/renderer/js/apps/explorer-actions.js';
import { createFileOperationsClient, fileOperations } from '../src/renderer/js/core/file-operations.js';
import { ICON_NAMES } from '../src/renderer/js/core/icons.data.js';
import { ServiceError } from '../src/renderer/js/core/services.js';
import { readText, stripComments } from './helpers.mjs';

const DOCUMENTS = 'C:\\Users\\Léo\\Documents';
const PROJECTS = `${DOCUMENTS}\\Projets`;

const file = (name, parent = DOCUMENTS) => ({ id: `${parent}\\${name}`, name, kind: 'file', path: `${parent}\\${name}` });
const folder = (name, parent = DOCUMENTS) => ({ id: `${parent}\\${name}`, name, kind: 'folder', path: `${parent}\\${name}`, location: { type: 'folder', path: `${parent}\\${name}` } });

/** Page d'un dossier réel, telle que la navigation la prépare. */
const folderPage = (path = DOCUMENTS, title = 'Documents', nodes = []) => ({
  kind: 'folder',
  title,
  location: { type: 'folder', path },
  message: null,
  sections: [{ nodes }],
});

const HOME = Object.freeze({ kind: 'home', title: 'Accueil', location: { type: 'home' }, message: null, sections: [] });
const COMPUTER = Object.freeze({ kind: 'pc', title: 'Ce PC', location: { type: 'pc' }, message: null, sections: [] });
/** Dossier qui n'a pas pu être lu : la page porte un message, pas un contenu. */
const UNREADABLE = Object.freeze({ kind: 'folder', title: 'Privé', location: { type: 'folder', path: `${DOCUMENTS}\\Privé` }, message: { title: 'Accès refusé' }, sections: [] });

const NOTHING = Object.freeze({ open: false, cut: false, copy: false, rename: false, trash: false, paste: false, newFolder: false });

// ---------------------------------------------------------------------------------
// Commandes utilisables
// ---------------------------------------------------------------------------------

test('dossier réel d’une page : là où l’on peut créer et coller', () => {
  assert.equal(folderOf(folderPage()), DOCUMENTS);
  for (const page of [null, undefined, HOME, COMPUTER, UNREADABLE, { kind: 'folder', location: {} }, { kind: 'folder', location: { path: '' } }, { kind: 'folder' }]) {
    assert.equal(folderOf(page), null, JSON.stringify(page));
  }
});

test('élément sur lequel une opération peut être demandée : un fichier ou un dossier lu dans un dossier réel', () => {
  assert.equal(isOperable(file('Notes.txt')), true);
  assert.equal(isOperable(folder('Projets')), true);
  // Ni un lecteur, ni un dossier personnel, ni un lien, ni un élément sans chemin.
  for (const node of [
    null,
    undefined,
    { name: 'Disque local (C:)', kind: 'drive', path: 'C:\\' },
    { name: 'Documents', kind: 'folder', path: DOCUMENTS, place: 'documents' },
    { name: 'Raccourci', kind: 'link', path: `${DOCUMENTS}\\Raccourci` },
    { name: 'Spécial', kind: 'other', path: `${DOCUMENTS}\\Spécial` },
    { name: 'Sans chemin', kind: 'file' },
    { name: 'Chemin vide', kind: 'file', path: '' },
    { name: 'Chemin étrange', kind: 'file', path: 42 },
  ]) {
    assert.equal(isOperable(node), false, JSON.stringify(node));
  }
});

test('commandes : chacune n’est utilisable que si elle a un sens — sélection, dossier réel, presse-papiers', () => {
  const state = (changes = {}) => availableCommands({ available: true, busy: false, page: folderPage(), selection: [], clipboard: 0, ...changes });

  // Dossier réel, rien de sélectionné : seul « Nouveau dossier ».
  assert.deepEqual(state(), { ...NOTHING, newFolder: true });
  // Un fichier : tout, sauf coller (presse-papiers vide).
  assert.deepEqual(state({ selection: [file('Notes.txt')] }), { open: true, cut: true, copy: true, rename: true, trash: true, paste: false, newFolder: true });
  // Un dossier : il s'ouvre dans l'explorateur.
  assert.deepEqual(state({ selection: [folder('Projets')] }), { open: true, cut: true, copy: true, rename: true, trash: true, paste: false, newFolder: true });
  // Plusieurs éléments : ni ouvrir, ni renommer.
  assert.deepEqual(state({ selection: [file('a.txt'), folder('b')] }), { open: false, cut: true, copy: true, rename: false, trash: true, paste: false, newFolder: true });
  // Presse-papiers rempli : coller devient possible, avec ou sans sélection.
  assert.equal(state({ clipboard: 3 }).paste, true);
  assert.equal(state({ clipboard: 1, selection: [file('a.txt')] }).paste, true);

  // Sélection qui contient un élément intouchable (lien, dossier personnel) : aucune opération.
  const link = { name: 'Lien', kind: 'link', path: `${DOCUMENTS}\\Lien`, location: { type: 'folder', path: `${DOCUMENTS}\\Lien` } };
  assert.deepEqual(state({ selection: [file('a.txt'), link] }), { ...NOTHING, newFolder: true });
  assert.deepEqual(state({ selection: [link] }), { ...NOTHING, open: true, newFolder: true }, 'un lien se parcourt, sans plus');
  const place = { name: 'Documents', kind: 'folder', path: DOCUMENTS, place: 'documents', location: { type: 'documents' } };
  const drive = { name: 'Disque local (C:)', kind: 'drive', path: 'C:\\', location: { type: 'folder', path: 'C:\\' } };

  // Accueil, « Ce PC », dossier illisible : ni création, ni collage, ni opération sur les éléments affichés.
  for (const page of [HOME, COMPUTER, UNREADABLE, null]) {
    assert.deepEqual(state({ page, clipboard: 2 }), NOTHING);
    assert.deepEqual(state({ page, clipboard: 2, selection: [place] }), { ...NOTHING, open: true });
    assert.deepEqual(state({ page, clipboard: 2, selection: [drive] }), { ...NOTHING, open: true });
    // Même un fichier ordinaire (résultat épinglé, par exemple) n'y est pas modifiable : seule son ouverture est proposée.
    assert.deepEqual(state({ page, clipboard: 2, selection: [file('a.txt')] }), { ...NOTHING, open: true });
  }

  // Une opération est en cours : tout est désactivé, sauf la navigation dans un dossier.
  assert.deepEqual(state({ busy: true, clipboard: 2, selection: [file('a.txt')] }), NOTHING);
  assert.deepEqual(state({ busy: true, clipboard: 2, selection: [folder('b')] }), { ...NOTHING, open: true });
  // Dans un navigateur, aucune opération n'existe.
  assert.deepEqual(state({ available: false, clipboard: 2, selection: [file('a.txt')] }), NOTHING);
  assert.deepEqual(state({ available: false, clipboard: 2 }), NOTHING);
});

// ---------------------------------------------------------------------------------
// Presse-papiers interne
// ---------------------------------------------------------------------------------

test('presse-papiers : il ne retient que des chemins d’éléments modifiables, et prévient de ses changements', () => {
  const clipboard = createFileClipboard();
  let changes = 0;
  const unsubscribe = clipboard.onChange(() => (changes += 1));
  assert.deepEqual([clipboard.mode, clipboard.size, clipboard.items], [null, 0, []]);
  clipboard.clear();
  assert.equal(changes, 0, 'vider un presse-papiers vide ne change rien');

  const notes = file('Notes.txt');
  clipboard.set('copy', [notes, folder('Projets'), { name: 'Documents', kind: 'folder', path: DOCUMENTS, place: 'documents' }, { name: 'Lien', kind: 'link', path: 'x' }]);
  assert.deepEqual([clipboard.mode, clipboard.size, changes], ['copy', 2, 1]);
  assert.deepEqual(clipboard.items, [
    { path: notes.path, name: 'Notes.txt', kind: 'file' },
    { path: `${DOCUMENTS}\\Projets`, name: 'Projets', kind: 'folder' },
  ]);
  assert.equal(clipboard.isCut(notes.path), false, 'un élément copié n’est pas en attente de déplacement');
  // Ce qui est lu est une copie : le modifier ne change pas le presse-papiers.
  clipboard.items[0].path = 'C:\\Windows';
  clipboard.items.length = 0;
  assert.equal(clipboard.items[0].path, notes.path);

  clipboard.set('cut', [notes]);
  assert.deepEqual([clipboard.mode, clipboard.size, changes], ['cut', 1, 2]);
  assert.equal(clipboard.isCut(notes.path), true);
  assert.equal(clipboard.isCut(`${DOCUMENTS}\\Projets`), false);

  // Rien de modifiable, ou mode inconnu : le presse-papiers se vide.
  clipboard.set('cut', [{ name: 'Lien', kind: 'link', path: 'x' }]);
  assert.deepEqual([clipboard.mode, clipboard.size, changes], [null, 0, 3]);
  clipboard.set('delete', [notes]);
  assert.deepEqual([clipboard.mode, clipboard.size], [null, 0]);
  clipboard.set('copy', [notes]);
  clipboard.clear();
  assert.deepEqual([clipboard.mode, clipboard.size, clipboard.isCut(notes.path)], [null, 0, false]);

  const before = changes;
  unsubscribe();
  clipboard.set('copy', [notes]);
  assert.equal(changes, before);
});

test('le presse-papiers de Windows n’est ni lu ni modifié, et l’interface ne touche jamais au disque', () => {
  for (const source of ['src/renderer/js/apps/explorer-actions.js', 'src/renderer/js/core/file-operations.js', 'src/renderer/js/apps/explorer.js', 'src/renderer/js/shell/dialogs.js']) {
    const code = stripComments(readText(source));
    assert.doesNotMatch(code, /navigator\.clipboard|execCommand|clipboardData|\bClipboardItem\b/, source);
    assert.doesNotMatch(code, /\brequire\s*\(|node:|\bfetch\s*\(|XMLHttpRequest|showOpenFilePicker|showSaveFilePicker|showDirectoryPicker|FileReader|createObjectURL/, source);
  }
  // Les deux modules sans affichage n'emploient ni page ni fenêtre : ils se testent ici même.
  for (const source of ['src/renderer/js/apps/explorer-actions.js', 'src/renderer/js/core/file-operations.js']) {
    assert.doesNotMatch(stripComments(readText(source)), /\b(?:document|window|localStorage|HTMLElement|querySelector)\b/, source);
  }
});

// ---------------------------------------------------------------------------------
// Petites fonctions
// ---------------------------------------------------------------------------------

test('nom proposé pour un nouveau dossier, partie du nom sélectionnée au renommage, noms cités', () => {
  assert.equal(freeFolderName([]), 'Nouveau dossier');
  assert.equal(freeFolderName(['Projets', 'Notes.txt']), 'Nouveau dossier');
  assert.equal(freeFolderName(['Nouveau dossier']), 'Nouveau dossier (2)');
  assert.equal(freeFolderName(['NOUVEAU DOSSIER', 'nouveau dossier (2)', 'Nouveau dossier (3)']), 'Nouveau dossier (4)', 'casse indifférente, comme Windows');
  assert.equal(freeFolderName(new Set(['Nouveau dossier', 'Nouveau dossier (3)'])), 'Nouveau dossier (2)');

  // Fichier : le nom sans l'extension ; dossier : le nom entier.
  assert.equal(baseLength({ name: 'Rapport été.docx', kind: 'file' }), 'Rapport été'.length);
  assert.equal(baseLength({ name: 'archive.tar.gz', kind: 'file' }), 'archive.tar'.length);
  assert.equal(baseLength({ name: 'LISEZMOI', kind: 'file' }), 8);
  assert.equal(baseLength({ name: '.gitignore', kind: 'file' }), 10, 'un nom qui commence par un point n’a pas d’extension');
  assert.equal(baseLength({ name: 'Projets v2.0', kind: 'folder' }), 12);

  assert.deepEqual(listNames(['a', 'b', 'c']), ['a', 'b', 'c']);
  const many = Array.from({ length: 30 }, (_value, index) => `fichier ${index + 1}`);
  const listed = listNames(many);
  assert.equal(listed.length, 12);
  assert.deepEqual(listed.slice(0, 11), many.slice(0, 11));
  assert.equal(listed.at(-1), '… et 19 autres éléments');
  assert.deepEqual(listNames(many.slice(0, 12)), many.slice(0, 12), 'douze noms tiennent : aucun n’est remplacé par un compte');
  assert.equal(listNames(many.slice(0, 13)).at(-1), '… et 2 autres éléments');
  assert.equal(MAX_ITEMS, 1000);
});

test('identifiant d’opération : unique, et admis par l’application de bureau', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newOperationId()));
  assert.equal(ids.size, 200);
  // Même forme que celle exigée par src/services/file-operations.js.
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
});

// ---------------------------------------------------------------------------------
// Comptes rendus
// ---------------------------------------------------------------------------------

const done = (name, parent = PROJECTS, extra = {}) => ({ source: `${DOCUMENTS}\\${name}`, name, path: `${parent}\\${name}`, ...extra });
const report = (changes = {}) => ({ status: 'done', done: [], skipped: [], failed: [], cancelled: false, links: 0, others: 0, ...changes });

test('compte rendu : tout s’est passé comme demandé — une simple notification', () => {
  assert.deepEqual(describeReport('copy', report({ done: [done('Notes.txt')] }), 'Projets'), {
    quiet: true,
    success: true,
    title: 'Copie terminée',
    message: '« Notes.txt » a été copié dans « Projets ».',
    details: [],
    note: '',
  });
  assert.equal(describeReport('copy', report({ done: [done('a'), done('b'), done('c')] }), 'Projets').message, '3 éléments ont été copiés dans « Projets ».');
  // Copie conservée à côté de l'original : c'est le nouveau nom qui est annoncé.
  const kept = report({ done: [{ source: `${DOCUMENTS}\\Notes.txt`, name: 'Notes - Copie.txt', path: `${DOCUMENTS}\\Notes - Copie.txt` }] });
  assert.equal(describeReport('copy', kept, 'Documents').message, '« Notes - Copie.txt » a été créé dans « Documents ».');

  const moved = describeReport('move', report({ done: [done('Notes.txt')] }), 'Projets');
  assert.deepEqual([moved.quiet, moved.title, moved.message], [true, 'Déplacement terminé', '« Notes.txt » a été déplacé vers « Projets ».']);
  assert.equal(describeReport('move', report({ done: [done('a'), done('b')] }), 'Projets').message, '2 éléments ont été déplacés vers « Projets ».');

  const trashed = describeReport('trash', report({ done: [{ source: `${DOCUMENTS}\\Notes.txt`, name: 'Notes.txt' }] }));
  assert.deepEqual([trashed.quiet, trashed.title, trashed.message], [true, 'Envoyé à la Corbeille', '« Notes.txt » a été envoyé à la Corbeille de Windows.']);
  const several = describeReport('trash', report({ done: [{ name: 'a' }, { name: 'b' }] }));
  assert.equal(several.message, '2 éléments ont été envoyés à la Corbeille de Windows.');
});

test('compte rendu : éléments ignorés à la demande de l’utilisateur ou déjà à leur place — toujours une notification', () => {
  const skipped = (name, reason) => ({ source: `${DOCUMENTS}\\${name}`, name, reason });

  const some = describeReport('copy', report({ done: [done('a.txt')], skipped: [skipped('b.txt', 'collision')] }), 'Projets');
  assert.deepEqual([some.quiet, some.success, some.title], [true, true, 'Copie terminée']);
  assert.equal(some.message, '« a.txt » a été copié dans « Projets ». Un élément a été ignoré : son nom était déjà pris.');

  const none = describeReport('copy', report({ skipped: [skipped('a.txt', 'collision'), skipped('b.txt', 'collision')] }), 'Projets');
  assert.deepEqual([none.quiet, none.success, none.title, none.message], [true, false, 'Aucun élément copié', '2 éléments ont été ignorés : leur nom était déjà pris.']);

  const same = describeReport('move', report({ skipped: [skipped('a.txt', 'same-location')] }), 'Documents');
  assert.deepEqual([same.quiet, same.success, same.title, same.message], [true, false, 'Aucun élément déplacé', 'Cet élément se trouve déjà dans ce dossier.']);
  assert.equal(describeReport('move', report({ skipped: [skipped('a', 'same-location'), skipped('b', 'same-location')] }), 'Documents').message, '2 éléments se trouvaient déjà dans ce dossier.');

  // Déplacement vers un autre lecteur : l'utilisateur apprend que l'original est à la Corbeille.
  const across = describeReport('move', report({ done: [done('Film.mp4', 'D:\\Vidéos', { original: 'trashed' })] }), 'Vidéos');
  assert.equal(across.quiet, true);
  assert.equal(across.message, "« Film.mp4 » a été déplacé vers « Vidéos ». Cet élément a changé de lecteur : il a été copié, puis l'original a été envoyé à la Corbeille de Windows.");
  const acrossMany = describeReport('move', report({ done: [done('a', 'D:\\x', { original: 'trashed' }), done('b', 'D:\\x', { original: 'trashed' })] }), 'x');
  assert.match(acrossMany.message, /Ces éléments ont changé de lecteur : ils ont été copiés, puis les originaux ont été envoyés à la Corbeille de Windows\.$/);
});

test('compte rendu : un échec, une interruption ou un élément laissé de côté sont détaillés dans une fenêtre', () => {
  const failed = (name, code, message, extra = {}) => ({ source: `${DOCUMENTS}\\${name}`, name, code, message, ...extra });

  // Copie en partie réussie.
  const partial = describeReport('copy', report({ done: [done('a.txt')], failed: [failed('b.txt', 'access-denied', 'Accès refusé.')] }), 'Projets');
  assert.deepEqual(partial, {
    quiet: false,
    success: true,
    title: 'Copie incomplète',
    message: "« a.txt » a été copié dans « Projets ». Un élément n'a pas pu être traité :",
    details: ['« b.txt » : Accès refusé.'],
    note: '',
  });

  // Rien n'a réussi.
  const nothing = describeReport('trash', report({ failed: [failed('a.txt', 'trash-failed', 'Reste à sa place.'), failed('b.txt', 'in-use', 'Utilisé par un autre programme.')] }));
  assert.deepEqual([nothing.quiet, nothing.success, nothing.title], [false, false, 'Envoi à la Corbeille impossible']);
  assert.equal(nothing.message, "2 éléments n'ont pas pu être traités :");
  assert.deepEqual(nothing.details, ['« a.txt » : Reste à sa place.', '« b.txt » : Utilisé par un autre programme.']);
  assert.equal(describeReport('move', report({ failed: [failed('a', 'failed', undefined)] }), 'x').details[0], "« a » : l'opération a échoué.");
  assert.equal(describeReport('move', report({ failed: [failed('a', 'failed', 'Échec.')] }), 'x').title, 'Déplacement impossible');

  // Dossier dont la copie s'est arrêtée en chemin : l'endroit de l'erreur et le nom de ce qui reste.
  const broken = describeReport('copy', report({ failed: [failed('Photos', 'no-space', 'Espace insuffisant.', { at: 'Été\\plage.jpg', partial: 'Photos (copie incomplète)' })] }), 'Sauvegarde');
  assert.deepEqual(broken.details, ['« Photos » (dans « Été\\plage.jpg ») : Espace insuffisant. Ce qui avait déjà été copié est conservé sous le nom « Photos (copie incomplète) ».']);
  // Copie entière, mais restée sous son nom provisoire.
  const pending = describeReport('copy', report({ failed: [failed('Photos', 'access-denied', 'Accès refusé.', { partial: 'Photos (copie en cours)', complete: true })] }), 'Sauvegarde');
  assert.deepEqual(pending.details, ['« Photos » : Accès refusé. La copie est complète, mais elle a gardé son nom provisoire : « Photos (copie en cours) ».']);

  // Annulation : ce qui est fait reste fait, le reste est énuméré.
  const cancelled = describeReport(
    'copy',
    report({
      cancelled: true,
      done: [done('a.txt')],
      skipped: [
        { source: `${DOCUMENTS}\\Photos`, name: 'Photos', reason: 'cancelled', partial: 'Photos (copie incomplète)' },
        { source: `${DOCUMENTS}\\c.txt`, name: 'c.txt', reason: 'cancelled' },
        { source: `${DOCUMENTS}\\d.txt`, name: 'd.txt', reason: 'collision' },
      ],
    }),
    'Projets',
  );
  assert.deepEqual([cancelled.quiet, cancelled.success, cancelled.title], [false, true, 'Copie annulée']);
  assert.equal(cancelled.message, "« a.txt » a été copié dans « Projets ». 2 éléments n'ont pas été traités :");
  assert.deepEqual(cancelled.details, [
    "« Photos » : non traité, l'opération a été annulée. Ce qui avait déjà été copié est conservé sous le nom « Photos (copie incomplète) ».",
    "« c.txt » : non traité, l'opération a été annulée.",
    '« d.txt » : ignoré, un élément porte déjà ce nom.',
  ]);
  assert.equal(describeReport('move', report({ cancelled: true, skipped: [{ name: 'a', reason: 'cancelled' }] }), 'x').title, 'Déplacement annulé');
  assert.equal(describeReport('trash', report({ cancelled: true, skipped: [{ name: 'a', reason: 'cancelled' }] })).title, 'Envoi à la Corbeille annulé');

  // Liens et éléments spéciaux d'un dossier copié : laissés de côté, et dits.
  const links = describeReport('copy', report({ done: [done('Projets')], links: 2, others: 1 }), 'Sauvegarde');
  assert.deepEqual([links.quiet, links.success, links.title, links.details], [false, true, 'Copie incomplète', []]);
  assert.equal(links.message, '« Projets » a été copié dans « Sauvegarde ».');
  assert.equal(links.note, "2 liens (liens symboliques ou jonctions) n'ont pas été copiés : Evolve ne copie pas les liens. 1 élément spécial n'a pas été copié.");
  assert.equal(describeReport('copy', report({ done: [done('Projets')], links: 1 }), 'x').note, "1 lien (lien symbolique ou jonction) n'a pas été copié : Evolve ne copie pas les liens.");

  // Déplacement vers un autre lecteur dont l'original n'a pas pu rejoindre la Corbeille : rien n'est perdu, et c'est dit.
  const keptOriginal = describeReport('move', report({ failed: [failed('Film.mp4', 'original-kept', "L'élément a été copié à destination, mais l'original n'a pas pu être envoyé à la Corbeille : il est resté à sa place.", { path: 'D:\\Vidéos\\Film.mp4' })] }), 'Vidéos');
  assert.deepEqual([keptOriginal.quiet, keptOriginal.title], [false, 'Déplacement impossible']);
  assert.match(keptOriginal.details[0], /^« Film\.mp4 » : L'élément a été copié à destination, mais l'original n'a pas pu être envoyé à la Corbeille/);

  // Un rapport incomplet ne fait pas échouer le compte rendu.
  assert.deepEqual(describeReport('copy', {}, 'x'), { quiet: true, success: false, title: 'Aucun élément copié', message: '', details: [], note: '' });
});

// ---------------------------------------------------------------------------------
// Demandes à l'application de bureau
// ---------------------------------------------------------------------------------

test('demandes : le résultat de l’application de bureau, ou une erreur portant son code — jamais d’accès direct', async () => {
  const calls = [];
  const replies = [];
  const listeners = new Set();
  const answer = (name) => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve(replies.shift());
  };
  const host = {
    createFolder: answer('createFolder'),
    rename: answer('rename'),
    copy: answer('copy'),
    move: answer('move'),
    trash: answer('trash'),
    open: answer('open'),
    cancel: answer('cancel'),
    onProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const client = createFileOperationsClient(host);
  assert.equal(client.available, true);
  assert.deepEqual(Object.keys(client), ['available', 'createFolder', 'rename', 'copy', 'move', 'trash', 'open', 'cancel', 'onProgress']);

  // Chaque demande est transmise telle quelle, à la fonction du même nom.
  replies.push({ ok: true, value: { path: `${DOCUMENTS}\\Factures`, name: 'Factures' } });
  assert.deepEqual(await client.createFolder(DOCUMENTS, 'Factures'), { path: `${DOCUMENTS}\\Factures`, name: 'Factures' });
  replies.push({ ok: true, value: { name: 'b.txt' } }, { ok: true, value: { status: 'done' } }, { ok: true, value: { status: 'collisions' } }, { ok: true, value: { status: 'done' } }, { ok: true, value: { opened: true } });
  await client.rename(`${DOCUMENTS}\\a.txt`, 'b.txt');
  await client.copy([`${DOCUMENTS}\\a.txt`], PROJECTS, { operation: 'op-1', onCollision: 'ask' });
  await client.move([`${DOCUMENTS}\\a.txt`], PROJECTS, { confirmed: true });
  await client.trash([`${DOCUMENTS}\\a.txt`], { confirmed: true });
  await client.open(`${DOCUMENTS}\\a.txt`, { confirmed: true });
  assert.deepEqual(calls, [
    ['createFolder', DOCUMENTS, 'Factures'],
    ['rename', `${DOCUMENTS}\\a.txt`, 'b.txt'],
    ['copy', [`${DOCUMENTS}\\a.txt`], PROJECTS, { operation: 'op-1', onCollision: 'ask' }],
    ['move', [`${DOCUMENTS}\\a.txt`], PROJECTS, { confirmed: true }],
    ['trash', [`${DOCUMENTS}\\a.txt`], { confirmed: true }],
    ['open', `${DOCUMENTS}\\a.txt`, { confirmed: true }],
  ]);

  // Refus : une erreur qui porte le code et le message de l'application de bureau.
  replies.push({ ok: false, code: 'collision', message: 'Un élément porte déjà ce nom.' });
  await assert.rejects(client.createFolder(DOCUMENTS, 'Factures'), (error) => error instanceof ServiceError && error.code === 'collision' && error.message === 'Un élément porte déjà ce nom.');
  // Réponse inattendue : un échec, jamais une réussite.
  for (const reply of [undefined, null, {}, { ok: 'true', value: 1 }, 'ok', { value: { path: 'x' } }]) {
    replies.push(reply);
    await assert.rejects(client.rename('a', 'b'), (error) => error instanceof ServiceError && error.code === 'failed', JSON.stringify(reply));
  }

  // Arrêt d'une opération : vrai seulement si l'application de bureau l'a pris en compte.
  replies.push({ ok: true, value: true }, { ok: true, value: false }, { ok: false, code: 'forbidden' }, undefined);
  assert.deepEqual([await client.cancel('op-1'), await client.cancel('op-1'), await client.cancel('op-1'), await client.cancel('op-1')], [true, false, false, false]);
  assert.equal(await createFileOperationsClient({ ...host, cancel: () => Promise.reject(new Error('canal fermé')) }).cancel('op-1'), false);

  // Avancement : abonnement et désabonnement transmis.
  const seen = [];
  const unsubscribe = client.onProgress((progress) => seen.push(progress));
  for (const listener of listeners) listener({ operation: 'op-1', state: 'running', done: 1, total: 2 });
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.deepEqual(seen, [{ operation: 'op-1', state: 'running', done: 1, total: 2 }]);
});

test('demandes : dans un navigateur, aucune opération n’existe', async () => {
  const client = createFileOperationsClient(null);
  assert.equal(client.available, false);
  for (const request of [
    () => client.createFolder(DOCUMENTS, 'Factures'),
    () => client.rename(`${DOCUMENTS}\\a.txt`, 'b.txt'),
    () => client.copy([`${DOCUMENTS}\\a.txt`], PROJECTS),
    () => client.move([`${DOCUMENTS}\\a.txt`], PROJECTS, { confirmed: true }),
    () => client.trash([`${DOCUMENTS}\\a.txt`], { confirmed: true }),
    () => client.open(`${DOCUMENTS}\\a.txt`),
  ]) {
    await assert.rejects(request(), (error) => error instanceof ServiceError && error.code === 'unavailable' && /application Windows/.test(error.message));
  }
  assert.equal(await client.cancel('op-1'), false);
  assert.equal(typeof client.onProgress(() => assert.fail('aucun avancement')), 'function');
  // Hors de l'application de bureau (ces tests, un navigateur), l'accès partagé est dans cet état.
  assert.equal(fileOperations.available, false);
});

// ---------------------------------------------------------------------------------
// Enchaînements : de la commande à la demande
// ---------------------------------------------------------------------------------

/**
 * Explorateur d'essai : fausses fenêtres de dialogue (réponses préparées),
 * fausses notifications, fausse application de bureau (réponses préparées).
 * Tout ce qui est demandé est consigné, dans l'ordre, dans `log`.
 */
function setup({ page = folderPage(), available = true } = {}) {
  const log = [];
  const answers = { prompt: [], confirm: [], choose: [], inform: [] };
  const replies = { createFolder: [], rename: [], copy: [], move: [], trash: [], open: [], cancel: [] };
  const progressListeners = new Set();
  const state = { page, selected: null, changes: 0, reloads: 0, progress: [] };

  /** Réponse préparée : une valeur, une erreur à lever, ou une fonction qui reçoit les arguments de la demande. */
  const respond = async (queue, name, args) => {
    assert.ok(queue.length > 0, `demande inattendue : ${name}`);
    const next = queue.shift();
    const value = typeof next === 'function' ? await next(...args) : next;
    if (value instanceof Error) throw value;
    return value;
  };

  const operations = { available, onProgress: (listener) => (progressListeners.add(listener), () => progressListeners.delete(listener)) };
  for (const name of Object.keys(replies)) {
    operations[name] = (...args) => {
      log.push([name, ...args]);
      return respond(replies[name], name, args);
    };
  }

  const dialogs = {
    /** Comme la vraie fenêtre : la saisie est soumise à `onSubmit` ; un refus (texte) la laisse ouverte. */
    async prompt(options) {
      log.push(['prompt', options.title, options.value]);
      state.lastPrompt = options;
      for (;;) {
        assert.ok(answers.prompt.length > 0, 'saisie inattendue');
        const typed = answers.prompt.shift();
        if (typed === null) return null;
        const problem = await options.onSubmit(typed);
        if (problem === null) return typed;
        log.push(['prompt-error', problem]);
      }
    },
    async confirm(options) {
      log.push(['confirm', options.title]);
      state.lastConfirm = options;
      assert.ok(answers.confirm.length > 0, 'confirmation inattendue');
      return answers.confirm.shift();
    },
    async choose(options) {
      log.push(['choose', options.title, options.actions.map((action) => action.id)]);
      state.lastChoose = options;
      assert.ok(answers.choose.length > 0, 'question inattendue');
      return answers.choose.shift();
    },
    async inform(options) {
      log.push(['inform', options.title]);
      state.lastInform = options;
    },
    progress(options) {
      const view = { options, updates: [], closed: false, update: (value) => view.updates.push(value), close: () => (view.closed = true) };
      state.progress.push(view);
      return view;
    },
  };

  const toasts = [];
  const clipboard = createFileClipboard();
  const actions = new FileActions({
    operations,
    dialogs,
    toasts: { show: (toast) => (toasts.push(toast), log.push(['toast', toast.title])) },
    clipboard,
    view: {
      page: () => state.page,
      reload: async () => {
        state.reloads += 1;
        log.push(['reload']);
      },
      select: (paths) => {
        state.selected = paths;
        log.push(['select', ...paths]);
      },
      changed: () => (state.changes += 1),
    },
  });
  const emitProgress = (event) => {
    for (const listener of progressListeners) listener(event);
  };
  return { actions, answers, replies, log, state, toasts, clipboard, emitProgress, progressListeners };
}

const refusal = (code, message) => new ServiceError(code, message);

test('nouveau dossier : nom proposé, refus affiché sous le champ, puis dossier sélectionné et annoncé', async () => {
  const page = folderPage(DOCUMENTS, 'Documents', [folder('Nouveau dossier'), file('Notes.txt')]);
  const { actions, answers, replies, log, state, toasts } = setup({ page });

  answers.prompt.push('  CON  ', 'Factures 2026');
  replies.createFolder.push(refusal('invalid-name', 'Ce nom est réservé par Windows (CON, PRN, AUX, NUL, COM1, LPT1…).'), { path: `${DOCUMENTS}\\Factures 2026`, name: 'Factures 2026' });
  await actions.newFolder();

  assert.deepEqual(log, [
    // Le nom proposé évite celui du dossier déjà présent.
    ['prompt', 'Nouveau dossier', 'Nouveau dossier (2)'],
    // Les espaces de bord sont retirés ; le nom lui-même est jugé par l'application de bureau.
    ['createFolder', DOCUMENTS, 'CON'],
    ['prompt-error', 'Ce nom est réservé par Windows (CON, PRN, AUX, NUL, COM1, LPT1…).'],
    ['createFolder', DOCUMENTS, 'Factures 2026'],
    ['reload'],
    ['select', `${DOCUMENTS}\\Factures 2026`],
    ['toast', 'Dossier créé'],
  ]);
  assert.equal(toasts[0].message, '« Factures 2026 » a été créé dans « Documents ».');
  assert.ok(ICON_NAMES.includes(toasts[0].glyph));
  assert.equal(actions.busy, false);
  assert.equal(state.changes, 2, 'commandes désactivées pendant la demande, puis réactivées');

  // Saisie abandonnée : rien n'est demandé.
  log.length = 0;
  answers.prompt.push(null);
  await actions.newFolder();
  assert.deepEqual(log, [['prompt', 'Nouveau dossier', 'Nouveau dossier (2)']]);
});

test('nouveau dossier et coller : impossibles hors d’un dossier réel — rien n’est demandé', async () => {
  for (const page of [HOME, COMPUTER, UNREADABLE]) {
    const { actions, log, clipboard, state } = setup({ page });
    clipboard.set('copy', [file('Notes.txt')]);
    await actions.newFolder();
    await actions.paste();
    await actions.rename(file('Notes.txt'));
    await actions.trash([file('Notes.txt')]);
    actions.cut([file('Autre.txt')]);
    assert.deepEqual(log, [], page.title);
    assert.equal(state.changes, 0);
    assert.equal(clipboard.items[0].name, 'Notes.txt', 'le presse-papiers n’a pas changé');
  }
});

test('renommer : nom actuel proposé sans l’extension, puis élément sélectionné sous son nouveau nom', async () => {
  const { actions, answers, replies, log, toasts, state } = setup();
  const node = file('Rapport été.docx');
  answers.prompt.push('  Bilan.docx ');
  replies.rename.push({ path: `${DOCUMENTS}\\Bilan.docx`, name: 'Bilan.docx' });
  await actions.rename(node);
  assert.deepEqual(log, [
    ['prompt', 'Renommer', 'Rapport été.docx'],
    ['rename', node.path, 'Bilan.docx'],
    ['reload'],
    ['select', `${DOCUMENTS}\\Bilan.docx`],
    ['toast', 'Élément renommé'],
  ]);
  assert.equal(toasts[0].message, "« Rapport été.docx » s'appelle maintenant « Bilan.docx ».");
  // Seul le nom, sans l'extension, est sélectionné dans le champ : la saisie laisse « .docx » en place.
  assert.equal(state.lastPrompt.selectTo, 'Rapport été'.length);
  assert.equal(state.lastPrompt.confirmLabel, 'Renommer');

  // Nom déjà pris : le refus reste sous le champ, puis l'utilisateur renonce — rien d'autre n'est fait.
  log.length = 0;
  answers.prompt.push('Notes.txt', null);
  replies.rename.push(refusal('collision', 'Un élément porte déjà ce nom à cet endroit. Rien n’a été remplacé.'));
  await actions.rename(node);
  assert.deepEqual(log, [
    ['prompt', 'Renommer', 'Rapport été.docx'],
    ['rename', node.path, 'Notes.txt'],
    ['prompt-error', 'Un élément porte déjà ce nom à cet endroit. Rien n’a été remplacé.'],
  ]);

  // Nom inchangé : ni relecture, ni annonce.
  log.length = 0;
  answers.prompt.push('Rapport été.docx');
  replies.rename.push({ path: node.path, name: node.name, unchanged: true });
  await actions.rename(node);
  assert.deepEqual(log, [['prompt', 'Renommer', 'Rapport été.docx'], ['rename', node.path, 'Rapport été.docx']]);
  assert.equal(state.reloads, 1);

  // Un dossier : son nom entier est sélectionné.
  log.length = 0;
  answers.prompt.push(null);
  await actions.rename(folder('Projets v2.0'));
  assert.equal(state.lastPrompt.selectTo, 'Projets v2.0'.length);

  // Un dossier personnel ou un lien ne se renomme pas : aucune question n'est posée.
  log.length = 0;
  await actions.rename({ name: 'Documents', kind: 'folder', path: DOCUMENTS, place: 'documents' });
  await actions.rename({ name: 'Lien', kind: 'link', path: `${DOCUMENTS}\\Lien` });
  assert.deepEqual(log, []);
});

test('copier et couper : seul le presse-papiers change — rien n’est demandé avant « Coller »', () => {
  const { actions, log, clipboard, toasts } = setup();
  const notes = file('Notes.txt');
  actions.copy([notes, folder('Projets')]);
  assert.deepEqual([clipboard.mode, clipboard.size], ['copy', 2]);
  actions.cut([notes]);
  assert.deepEqual([clipboard.mode, clipboard.size, clipboard.isCut(notes.path)], ['cut', 1, true]);
  assert.deepEqual(log, []);

  // Sélection vide ou intouchable : le presse-papiers garde son contenu.
  actions.copy([]);
  actions.cut([{ name: 'Documents', kind: 'folder', path: DOCUMENTS, place: 'documents' }]);
  actions.copy([notes, { name: 'Lien', kind: 'link', path: 'x' }]);
  assert.deepEqual([clipboard.mode, clipboard.size], ['cut', 1]);

  // Plus de mille éléments : annoncé, rien n'est retenu.
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_value, index) => file(`fichier ${index}.txt`));
  actions.copy(many);
  assert.deepEqual([clipboard.mode, clipboard.size], ['cut', 1]);
  assert.deepEqual(log, [['toast', 'Sélection trop importante']]);
  assert.match(toasts[0].message, /1\s000 éléments au plus/);
  actions.copy(many.slice(0, MAX_ITEMS));
  assert.deepEqual([clipboard.mode, clipboard.size], ['copy', MAX_ITEMS]);
});

test('coller une copie : demandée sans choix préalable ; les éléments collés sont sélectionnés, le presse-papiers est conservé', async () => {
  const { actions, replies, log, clipboard, toasts, state } = setup({ page: folderPage(PROJECTS, 'Projets') });
  const notes = file('Notes.txt');
  actions.copy([notes, folder('Photos')]);
  replies.copy.push(report({ destination: PROJECTS, done: [done('Notes.txt'), done('Photos')] }));
  await actions.paste();

  const [request] = log;
  assert.deepEqual(request.slice(0, 3), ['copy', [notes.path, `${DOCUMENTS}\\Photos`], PROJECTS]);
  // Premier essai : devant un nom déjà pris, l'application de bureau doit poser la question, sans rien modifier.
  assert.deepEqual(Object.keys(request[3]).sort(), ['onCollision', 'operation']);
  assert.equal(request[3].onCollision, 'ask');
  assert.match(request[3].operation, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(log.slice(1), [['reload'], ['select', `${PROJECTS}\\Notes.txt`, `${PROJECTS}\\Photos`], ['toast', 'Copie terminée']]);
  assert.equal(toasts[0].message, '2 éléments ont été copiés dans « Projets ».');
  assert.deepEqual([clipboard.mode, clipboard.size], ['copy', 2], 'une copie peut être collée de nouveau');

  // Fenêtre d'avancement : ouverte pour la demande, fermée ensuite.
  assert.equal(state.progress.length, 1);
  assert.deepEqual([state.progress[0].options.title, state.progress[0].options.message, state.progress[0].closed], ['Copie en cours', 'Copie de 2 éléments vers « Projets »…', true]);
});

test('coller devant un nom déjà pris : la question est posée — conserver les deux, ignorer, ou renoncer ; jamais remplacer', async () => {
  const collisions = { status: 'collisions', operation: 'copy', destination: PROJECTS, collisions: [{ source: `${DOCUMENTS}\\Notes.txt`, name: 'Notes.txt' }], count: 2 };

  // Conserver les deux : la même demande est renouvelée avec ce choix.
  {
    const { actions, answers, replies, log, state } = setup({ page: folderPage(PROJECTS, 'Projets') });
    actions.copy([file('Notes.txt'), file('Budget.xlsx')]);
    answers.choose.push('keep-both');
    replies.copy.push(collisions, report({ done: [done('Notes.txt', PROJECTS, { name: 'Notes - Copie.txt', path: `${PROJECTS}\\Notes - Copie.txt` }), done('Budget.xlsx')] }));
    await actions.paste();
    assert.deepEqual(log.map((entry) => entry[0]), ['copy', 'choose', 'copy', 'reload', 'select', 'toast']);
    assert.deepEqual([log[0][3].onCollision, log[2][3].onCollision], ['ask', 'keep-both']);
    assert.deepEqual(log[1], ['choose', '« Notes.txt » existe déjà', ['keep-both', 'skip']]);
    assert.match(state.lastChoose.message, /Evolve ne remplace jamais un élément existant\.$/);
    assert.deepEqual(log[4], ['select', `${PROJECTS}\\Notes - Copie.txt`, `${PROJECTS}\\Budget.xlsx`]);
    // Aucun des choix proposés ne remplace quoi que ce soit.
    for (const action of state.lastChoose.actions) assert.doesNotMatch(`${action.id} ${action.label}`, /rempla|écras|replace|overwrite/i);
  }

  // Ignorer : les éléments qui gênent sont laissés de côté.
  {
    const { actions, answers, replies, log, toasts } = setup({ page: folderPage(PROJECTS, 'Projets') });
    actions.copy([file('Notes.txt'), file('Budget.xlsx')]);
    answers.choose.push('skip');
    replies.copy.push(collisions, report({ done: [done('Budget.xlsx')], skipped: [{ source: `${DOCUMENTS}\\Notes.txt`, name: 'Notes.txt', reason: 'collision' }] }));
    await actions.paste();
    assert.deepEqual([log[0][3].onCollision, log[2][3].onCollision], ['ask', 'skip']);
    assert.equal(toasts[0].message, '« Budget.xlsx » a été copié dans « Projets ». Un élément a été ignoré : son nom était déjà pris.');
  }

  // Renoncer (Annuler, Échap) : une seule demande a été faite, et elle n'a rien modifié.
  for (const answer of [null, undefined, 'replace', 'cancel']) {
    const { actions, answers, replies, log, clipboard } = setup({ page: folderPage(PROJECTS, 'Projets') });
    actions.cut([file('Notes.txt'), file('Budget.xlsx')]);
    answers.confirm.push(true);
    answers.choose.push(answer);
    replies.move.push({ ...collisions, operation: 'move' });
    await actions.paste();
    assert.deepEqual(log.map((entry) => entry[0]), ['confirm', 'move', 'choose'], String(answer));
    assert.deepEqual([clipboard.mode, clipboard.size], ['cut', 2], 'les éléments coupés restent en attente');
  }

  // Plusieurs noms déjà pris : ils sont cités.
  {
    const { actions, answers, replies, log, state } = setup({ page: folderPage(PROJECTS, 'Projets') });
    actions.copy([file('a.txt'), file('b.txt')]);
    answers.choose.push(null);
    replies.copy.push({ ...collisions, collisions: [{ source: 'x', name: 'a.txt' }, { source: 'y', name: 'b.txt' }] });
    await actions.paste();
    assert.deepEqual(log[1], ['choose', '2 éléments portent déjà ce nom', ['keep-both', 'skip']]);
    assert.deepEqual(state.lastChoose.details, ['a.txt', 'b.txt']);
  }
});

test('coller des éléments coupés : le déplacement est confirmé avant d’être demandé, puis le presse-papiers se vide', async () => {
  // Confirmation refusée : rien n'est demandé, les éléments restent en attente.
  {
    const { actions, answers, log, clipboard } = setup({ page: folderPage(PROJECTS, 'Projets') });
    actions.cut([file('Notes.txt')]);
    answers.confirm.push(false);
    await actions.paste();
    assert.deepEqual(log, [['confirm', 'Déplacer « Notes.txt » ?']]);
    assert.deepEqual([clipboard.mode, clipboard.size], ['cut', 1]);
  }

  // Confirmation donnée : la demande la déclare ; ensuite, plus rien n'est en attente.
  {
    const { actions, answers, replies, log, clipboard, toasts, state } = setup({ page: folderPage(PROJECTS, 'Projets') });
    const notes = file('Notes.txt');
    actions.cut([notes, folder('Photos')]);
    answers.confirm.push(true);
    replies.move.push(report({ operation: 'move', destination: PROJECTS, done: [done('Notes.txt'), done('Photos')] }));
    await actions.paste();
    assert.deepEqual(log[0], ['confirm', 'Déplacer 2 éléments ?']);
    assert.deepEqual(state.lastConfirm.details, ['Notes.txt', 'Photos']);
    assert.deepEqual(log[1].slice(0, 3), ['move', [notes.path, `${DOCUMENTS}\\Photos`], PROJECTS]);
    assert.deepEqual([log[1][3].confirmed, log[1][3].onCollision], [true, 'ask']);
    assert.deepEqual(log.slice(2), [['reload'], ['select', `${PROJECTS}\\Notes.txt`, `${PROJECTS}\\Photos`], ['toast', 'Déplacement terminé']]);
    assert.equal(toasts[0].message, '2 éléments ont été déplacés vers « Projets ».');
    assert.deepEqual([clipboard.mode, clipboard.size], [null, 0]);
    assert.equal(state.progress[0].options.title, 'Déplacement en cours');

    // Presse-papiers vide : « Coller » ne demande plus rien.
    log.length = 0;
    await actions.paste();
    assert.deepEqual(log, []);
  }
});

test('coller : un refus de l’application de bureau est annoncé, et rien d’autre n’est fait', async () => {
  const { actions, replies, log, toasts, clipboard, state } = setup({ page: folderPage(PROJECTS, 'Projets') });
  actions.copy([folder('Projets')]);
  replies.copy.push(refusal('into-itself', 'Un dossier ne peut pas être copié dans lui-même, ni dans l’un de ses sous-dossiers.'));
  await actions.paste();
  assert.deepEqual(log.map((entry) => entry[0]), ['copy', 'toast']);
  assert.deepEqual([toasts[0].title, toasts[0].message], ['Copie impossible', 'Un dossier ne peut pas être copié dans lui-même, ni dans l’un de ses sous-dossiers.']);
  assert.equal(state.reloads, 0);
  assert.equal(clipboard.size, 1);
  assert.equal(state.progress[0].closed, true, 'la fenêtre d’avancement est toujours refermée');
  assert.equal(actions.busy, false);
});

test('coller : une copie incomplète ou annulée est détaillée dans une fenêtre ; ce qui a été fait est sélectionné', async () => {
  const { actions, replies, log, state } = setup({ page: folderPage(PROJECTS, 'Projets') });
  actions.copy([file('a.txt'), folder('Photos')]);
  replies.copy.push(
    report({
      cancelled: true,
      done: [done('a.txt')],
      skipped: [{ source: `${DOCUMENTS}\\Photos`, name: 'Photos', reason: 'cancelled', partial: 'Photos (copie incomplète)' }],
    }),
  );
  await actions.paste();
  assert.deepEqual(log.slice(1), [['reload'], ['select', `${PROJECTS}\\a.txt`], ['inform', 'Copie annulée']]);
  assert.equal(state.lastInform.message, "« a.txt » a été copié dans « Projets ». Un élément n'a pas été traité :");
  assert.deepEqual(state.lastInform.details, ["« Photos » : non traité, l'opération a été annulée. Ce qui avait déjà été copié est conservé sous le nom « Photos (copie incomplète) »."]);
});

test('avancement : seule l’opération en cours met la fenêtre à jour ; « Annuler » demande son arrêt', async () => {
  const { actions, replies, log, state, emitProgress } = setup({ page: folderPage(PROJECTS, 'Projets') });
  actions.copy([folder('Photos')]);

  let finish;
  replies.copy.push((_sources, _destination, choices) => {
    const id = choices.operation;
    const [view] = state.progress;
    // Annonces de l'application de bureau pendant la copie.
    emitProgress({ operation: id, kind: 'copy', state: 'running', done: 3, total: 40, current: 'plage.jpg' });
    emitProgress({ operation: 'autre-operation', kind: 'copy', state: 'running', done: 9, total: 9, current: 'intrus' });
    emitProgress({ operation: id, kind: 'copy', state: 'running', done: 4, total: null, current: 42 });
    emitProgress({ operation: id, kind: 'copy', state: 'finished' });
    emitProgress(null);
    assert.deepEqual(view.updates, [
      { done: 3, total: 40, current: 'plage.jpg' },
      { done: 4, total: null, current: '' },
    ]);
    // L'utilisateur choisit « Annuler » : l'arrêt de cette opération est demandé.
    view.options.onCancel();
    assert.deepEqual(log.at(-1), ['cancel', id]);
    return new Promise((resolve) => (finish = resolve));
  });
  replies.cancel.push(true);

  const pending = actions.paste();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.busy, true);
  // Tant que l'opération dure, aucune autre commande n'est acceptée.
  assert.deepEqual(actions.commands([file('Notes.txt')]), NOTHING);
  await actions.newFolder();
  await actions.trash([file('Notes.txt')]);
  await actions.open(file('Notes.txt'));
  actions.cut([file('Notes.txt')]);
  assert.deepEqual(log.map((entry) => entry[0]), ['copy', 'cancel']);

  finish(report({ cancelled: true, skipped: [{ source: `${DOCUMENTS}\\Photos`, name: 'Photos', reason: 'cancelled', partial: 'Photos (copie incomplète)' }] }));
  await pending;
  assert.equal(actions.busy, false);
  assert.equal(state.progress[0].closed, true);
  assert.deepEqual(log.slice(2), [['reload'], ['inform', 'Copie annulée']]);

  // L'opération terminée, ses annonces tardives ne mettent plus rien à jour.
  emitProgress({ operation: log[0][3].operation, kind: 'copy', state: 'running', done: 5, total: 40, current: 'tardif' });
  assert.equal(state.progress[0].updates.length, 2);
});

test('envoyer à la Corbeille : confirmé avant d’être demandé ; rien n’est supprimé définitivement', async () => {
  // Confirmation refusée : aucune demande.
  {
    const { actions, answers, log, state } = setup();
    answers.confirm.push(false);
    await actions.trash([file('Notes.txt')]);
    assert.deepEqual(log, [['confirm', 'Envoyer « Notes.txt » à la Corbeille ?']]);
    assert.deepEqual([state.lastConfirm.tone, state.lastConfirm.confirmLabel], ['danger', 'Envoyer à la Corbeille']);
    assert.equal(state.lastConfirm.message, 'Ce fichier sera envoyé à la Corbeille de Windows.');
    assert.equal(state.lastConfirm.note, "Rien n'est supprimé définitivement : vous pourrez le restaurer depuis la Corbeille de Windows.");
    assert.equal(state.reloads, 0);
  }

  // Confirmation donnée : la demande la déclare.
  {
    const { actions, answers, replies, log, toasts, state } = setup();
    const notes = file('Notes.txt');
    const photos = folder('Photos');
    answers.confirm.push(true);
    replies.trash.push(report({ operation: 'trash', done: [{ source: notes.path, name: 'Notes.txt' }, { source: photos.path, name: 'Photos' }] }));
    await actions.trash([notes, photos]);
    assert.deepEqual(log[0], ['confirm', 'Envoyer 2 éléments à la Corbeille ?']);
    assert.deepEqual(state.lastConfirm.details, ['Notes.txt', 'Photos']);
    assert.deepEqual(log[1].slice(0, 2), ['trash', [notes.path, photos.path]]);
    assert.deepEqual(Object.keys(log[1][2]).sort(), ['confirmed', 'operation']);
    assert.equal(log[1][2].confirmed, true);
    assert.deepEqual(log.slice(2), [['reload'], ['toast', 'Envoyé à la Corbeille']]);
    assert.equal(toasts[0].message, '2 éléments ont été envoyés à la Corbeille de Windows.');
    assert.equal(state.progress[0].options.title, 'Envoi à la Corbeille');
  }

  // Dossier : le message précise que son contenu part avec lui.
  {
    const { actions, answers, state } = setup();
    answers.confirm.push(false);
    await actions.trash([folder('Photos')]);
    assert.equal(state.lastConfirm.message, 'Ce dossier et tout son contenu seront envoyés à la Corbeille de Windows.');
  }

  // La Corbeille refuse un élément : il reste à sa place, et c'est dit dans une fenêtre.
  {
    const { actions, answers, replies, log, state } = setup();
    answers.confirm.push(true);
    replies.trash.push(report({ failed: [{ source: `${DOCUMENTS}\\Notes.txt`, name: 'Notes.txt', code: 'trash-failed', message: "Windows n'a pas pu envoyer cet élément à la Corbeille : il n'a pas été supprimé et reste à sa place." }] }));
    await actions.trash([file('Notes.txt')]);
    assert.deepEqual(log.slice(2), [['reload'], ['inform', 'Envoi à la Corbeille impossible']]);
    assert.deepEqual(state.lastInform.details, ["« Notes.txt » : Windows n'a pas pu envoyer cet élément à la Corbeille : il n'a pas été supprimé et reste à sa place."]);
  }

  // Refus de l'application de bureau (élément protégé) : annoncé.
  {
    const { actions, answers, replies, log, toasts } = setup();
    answers.confirm.push(true);
    replies.trash.push(refusal('protected', 'Cet emplacement appartient au système.'));
    await actions.trash([file('Notes.txt')]);
    assert.deepEqual(log.map((entry) => entry[0]), ['confirm', 'trash', 'toast']);
    assert.deepEqual([toasts[0].title, toasts[0].message], ['Envoi à la Corbeille impossible', 'Cet emplacement appartient au système.']);
  }

  // Sélection intouchable, vide ou démesurée : aucune question, aucune demande.
  {
    const { actions, log } = setup();
    await actions.trash([]);
    await actions.trash([{ name: 'Documents', kind: 'folder', path: DOCUMENTS, place: 'documents' }]);
    await actions.trash([file('a.txt'), { name: 'Disque', kind: 'drive', path: 'C:\\' }]);
    assert.deepEqual(log, []);
    await actions.trash(Array.from({ length: MAX_ITEMS + 1 }, (_value, index) => file(`f${index}`)));
    assert.deepEqual(log, [['toast', 'Sélection trop importante']]);
  }
});

test('ouvrir un fichier : confié à Windows ; un programme, un script ou un raccourci exige une confirmation explicite', async () => {
  // Document ordinaire : une seule demande, sans confirmation.
  {
    const { actions, replies, log } = setup();
    const notes = file('Notes.txt');
    replies.open.push({ opened: true, path: notes.path, name: 'Notes.txt' });
    await actions.open(notes);
    assert.deepEqual(log, [['open', notes.path]]);
  }

  // Programme : l'application de bureau exige la confirmation ; par défaut, la touche Entrée n'ouvre rien.
  const needs = () => refusal('needs-confirmation', 'Ce fichier est un programme, un script ou un raccourci : l’ouvrir exécute du code sur cet ordinateur, avec vos droits.');
  {
    const { actions, answers, replies, log, state } = setup();
    const program = file('Installer.exe');
    answers.confirm.push(false);
    replies.open.push(needs());
    await actions.open(program);
    assert.deepEqual(log, [['open', program.path], ['confirm', 'Ouvrir « Installer.exe » ?']]);
    assert.equal(state.lastConfirm.focus, 'cancel');
    assert.equal(state.lastConfirm.tone, 'warning');
    assert.match(state.lastConfirm.message, /exécute du code sur cet ordinateur/);
  }
  {
    const { actions, answers, replies, log } = setup();
    const program = file('Installer.exe');
    answers.confirm.push(true);
    replies.open.push(needs(), { opened: true, path: program.path, name: 'Installer.exe' });
    await actions.open(program);
    assert.deepEqual(log, [['open', program.path], ['confirm', 'Ouvrir « Installer.exe » ?'], ['open', program.path, { confirmed: true }]]);
  }

  // Échec (aucune application associée, élément disparu) : annoncé, avec le nom du fichier.
  {
    const { actions, replies, log, toasts } = setup();
    replies.open.push(refusal('open-failed', "Windows n'a pas pu ouvrir ce fichier : aucune application ne lui est peut-être associée."));
    await actions.open(file('Données.xyz'));
    assert.deepEqual(log.map((entry) => entry[0]), ['open', 'toast']);
    assert.deepEqual([toasts[0].title, toasts[0].message], ['Ouverture impossible : Données.xyz', "Windows n'a pas pu ouvrir ce fichier : aucune application ne lui est peut-être associée."]);
  }
  {
    const { actions, answers, replies, log, toasts } = setup();
    answers.confirm.push(true);
    replies.open.push(needs(), refusal('not-found', 'Cet élément est introuvable.'));
    await actions.open(file('Installer.exe'));
    assert.deepEqual(log.map((entry) => entry[0]), ['open', 'confirm', 'open', 'toast']);
    assert.equal(toasts[0].title, 'Ouverture impossible : Installer.exe');
  }

  // Un dossier, un lecteur, un élément sans chemin : rien n'est confié à Windows.
  {
    const { actions, log } = setup();
    await actions.open(folder('Projets'));
    await actions.open({ name: 'Disque local (C:)', kind: 'drive', path: 'C:\\' });
    await actions.open({ name: 'Sans chemin', kind: 'file' });
    assert.deepEqual(log, []);
  }
});

test('dans un navigateur : aucune commande n’est utilisable, et rien n’est demandé', async () => {
  const { actions, log, clipboard } = setup({ available: false });
  const notes = file('Notes.txt');
  assert.deepEqual(actions.commands([notes]), NOTHING);
  await actions.newFolder();
  await actions.rename(notes);
  actions.copy([notes]);
  actions.cut([notes]);
  await actions.paste();
  await actions.trash([notes]);
  await actions.open(notes);
  assert.deepEqual(log, []);
  assert.equal(clipboard.size, 0);
});

test('une erreur imprévue est annoncée, jamais passée sous silence, et les commandes sont rendues', async () => {
  const { actions, answers, replies, log, toasts } = setup();
  answers.confirm.push(true);
  replies.trash.push(() => {
    throw new TypeError('réponse illisible');
  });
  await actions.trash([file('Notes.txt')]);
  assert.deepEqual(log.map((entry) => entry[0]), ['confirm', 'trash', 'toast']);
  // Le détail interne n'est pas montré à l'utilisateur : seuls les messages de l'application de bureau le sont.
  assert.deepEqual([toasts[0].title, toasts[0].message], ['Envoi à la Corbeille impossible', "L'opération a échoué."]);
  assert.equal(actions.busy, false);

  // Erreur dans l'affichage lui-même (ici, la relecture du dossier) : annoncée de la même façon.
  const shown = [];
  let changes = 0;
  const failing = new FileActions({
    operations: { available: true, onProgress: () => () => {}, createFolder: async () => ({ path: `${DOCUMENTS}\\Factures`, name: 'Factures' }) },
    dialogs: { prompt: async (options) => ((await options.onSubmit('Factures')) === null ? 'Factures' : null) },
    toasts: { show: (toast) => shown.push([toast.title, toast.message]) },
    clipboard: createFileClipboard(),
    view: {
      page: () => folderPage(),
      reload: async () => {
        throw new Error('relecture impossible');
      },
      select: () => assert.fail('rien à sélectionner'),
      changed: () => (changes += 1),
    },
  });
  const reported = [];
  const consoleError = console.error;
  console.error = (...args) => reported.push(args);
  try {
    await failing.newFolder();
  } finally {
    console.error = consoleError;
  }
  assert.deepEqual(shown, [['Opération impossible', "L'opération a échoué."]]);
  assert.deepEqual(reported.map(([error]) => error.message), ['relecture impossible'], 'le détail va au journal');
  assert.deepEqual([failing.busy, changes], [false, 2]);
});

test('fenêtre de l’explorateur fermée : l’avancement n’est plus écouté', () => {
  const { actions, progressListeners } = setup();
  assert.equal(progressListeners.size, 1);
  actions.dispose();
  assert.equal(progressListeners.size, 0);
  actions.dispose();
});

test('chaque pictogramme employé par les opérations existe', () => {
  const code = stripComments(readText('src/renderer/js/apps/explorer-actions.js'));
  const glyphs = [];
  for (const [, expression] of code.matchAll(/\bglyph: ([^\n]+)/g)) {
    // Noms cités dans l'expression, hormis ceux auxquels une valeur est comparée (« kind === 'move' »).
    const names = [...expression.matchAll(/(===\s*)?'([a-z-]+)'/g)].filter((match) => !match[1]).map((match) => match[2]);
    assert.ok(names.length > 0, `pictogramme non reconnu : ${expression}`);
    glyphs.push(...names);
  }
  assert.equal(glyphs.length, 17, `pictogrammes relevés : ${glyphs.join(', ')}`);
  assert.deepEqual([...new Set(glyphs)].sort(), ['check', 'copy', 'folder-plus', 'info', 'pencil-simple-line', 'scissors', 'trash', 'warning-circle']);
  for (const glyph of glyphs) assert.ok(ICON_NAMES.includes(glyph), `pictogramme inconnu : ${glyph}`);
});
