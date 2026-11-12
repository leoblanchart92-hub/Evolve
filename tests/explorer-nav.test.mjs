/**
 * Navigation de l'explorateur de fichiers (apps/explorer-nav.js) et types de
 * fichiers (core/file-types.js) : modules sans DOM, testés avec un faux
 * service de fichiers.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { LOCATION_IDS, Navigator, PLACES, driveName, locationKey, toLocation, visibleNodes } from '../src/renderer/js/apps/explorer-nav.js';
import { FILE_TYPES, describeNode, extensionOf, isContainer, sortNodes } from '../src/renderer/js/core/file-types.js';
import { ICON_NAMES } from '../src/renderer/js/core/icons.data.js';
import { readText, stripComments } from './helpers.mjs';

// Message que l'auto-test de la compilation attend devant un dossier Documents absent.
const documentsTest = createRequire(import.meta.url)('../src/main/selftest-documents.js');

const PROFILE = 'C:\\Users\\Léo';
const DOCUMENTS = `${PROFILE}\\Documents`;

/** Réponse du service « places » d'un PC ordinaire. */
const KNOWN = Object.freeze({
  places: [
    { id: 'desktop', path: `${PROFILE}\\Desktop`, available: true },
    { id: 'documents', path: DOCUMENTS, available: true },
    { id: 'downloads', path: `${PROFILE}\\Downloads`, available: true },
    { id: 'pictures', path: `${PROFILE}\\Pictures`, available: true },
    { id: 'music', path: null, available: false },
    { id: 'videos', path: null, available: false },
  ],
  drives: [
    { id: 'C:', letter: 'C', path: 'C:\\', system: true, totalBytes: 512e9, freeBytes: 128e9 },
    { id: 'D:', letter: 'D', path: 'D:\\', system: false, totalBytes: null, freeBytes: null },
  ],
});

const entry = (name, kind, extra = {}) => ({ name, path: `${extra.parent ?? DOCUMENTS}\\${name}`, kind, size: kind === 'file' ? 10 : null, modified: Date.UTC(2026, 2, 14), hidden: false, ...extra, parent: undefined });

/** Contenus connus du faux service, par chemin. */
const LISTINGS = {
  [DOCUMENTS]: {
    path: DOCUMENTS,
    root: { id: 'documents', kind: 'place', path: DOCUMENTS },
    trail: [],
    entries: [
      entry('Projets', 'folder'),
      entry('Privé', 'folder'),
      entry('Budget 2026.xlsx', 'file', { size: 48_300 }),
      entry('Mes images', 'link', { hidden: true }),
      entry('desktop.ini', 'file', { hidden: true }),
    ],
    truncated: false,
    limit: 5000,
  },
  [`${DOCUMENTS}\\Projets`]: {
    path: `${DOCUMENTS}\\Projets`,
    root: { id: 'documents', kind: 'place', path: DOCUMENTS },
    trail: [{ name: 'Projets', path: `${DOCUMENTS}\\Projets` }],
    entries: [],
    truncated: false,
    limit: 5000,
  },
  [PROFILE]: {
    path: PROFILE,
    root: { id: 'C:', kind: 'drive', path: 'C:\\' },
    trail: [
      { name: 'Users', path: 'C:\\Users' },
      { name: 'Léo', path: PROFILE },
    ],
    entries: [
      entry('Desktop', 'folder', { parent: PROFILE, place: 'desktop' }),
      entry('Documents', 'folder', { parent: PROFILE, place: 'documents' }),
      entry('AppData', 'folder', { parent: PROFILE, hidden: true }),
    ],
    truncated: true,
    limit: 3,
  },
  'C:\\': { path: 'C:\\', root: { id: 'C:', kind: 'drive', path: 'C:\\' }, trail: [], entries: [entry('Users', 'folder', { parent: 'C:' })], truncated: false, limit: 5000 },
  'D:\\': { path: 'D:\\', root: { id: 'D:', kind: 'drive', path: 'D:\\' }, trail: [], entries: [], truncated: false, limit: 5000 },
  // Lien : le service répond par la destination réelle.
  [`${DOCUMENTS}\\Mes images`]: { path: `${PROFILE}\\Pictures`, root: { id: 'pictures', kind: 'place', path: `${PROFILE}\\Pictures` }, trail: [], entries: [], truncated: false, limit: 5000 },
};

/** Erreur telle que le client des services la transmet : un code, ou une erreur déjà construite. */
const coded = (code) => (code instanceof Error ? code : Object.assign(new Error(`refus : ${code}`), { code }));

/**
 * Faux service de fichiers. `failures` : code d'erreur par chemin ;
 * `gates` : chemins dont la réponse attend un signal (`release`).
 */
function fakeFiles({ available = true, known = KNOWN, failures = {}, gates = [] } = {}) {
  const calls = [];
  const waiting = new Map();
  const files = {
    available,
    calls,
    known,
    failures,
    async places() {
      calls.push(['places']);
      if (failures.places) throw coded(failures.places);
      return files.known;
    },
    async list(target) {
      calls.push(['list', target]);
      if (gates.includes(target)) await new Promise((resolve) => waiting.set(target, resolve));
      if (failures[target]) throw coded(failures[target]);
      if (!LISTINGS[target]) throw coded('not-found');
      return LISTINGS[target];
    },
    release: (target) => waiting.get(target)?.(),
  };
  return files;
}

/** Navigateur relié à un faux service ; `states` reçoit chaque changement annoncé. */
function createNavigator(options) {
  const files = fakeFiles(options);
  const states = [];
  const nav = new Navigator({ files, onChange: () => states.push(nav.loading ? 'chargement' : nav.page.key) });
  return { nav, files, states };
}

const labels = (page) => page.crumbs.map((crumb) => crumb.label);
const names = (page) => page.sections.flatMap((section) => section.nodes).map((node) => node.name);

// ---------------------------------------------------------------------------------
// Emplacements
// ---------------------------------------------------------------------------------

test('emplacements désignés par un nom : quatre pages et les six dossiers personnels', () => {
  assert.deepEqual(LOCATION_IDS, ['home', 'pc', 'network', 'trash', 'desktop', 'documents', 'pictures', 'music', 'downloads', 'videos']);
  assert.deepEqual(PLACES.map((place) => place.name), ['Bureau', 'Documents', 'Images', 'Musique', 'Téléchargements', 'Vidéos']);
  assert.ok(Object.isFrozen(PLACES) && Object.isFrozen(LOCATION_IDS));
  for (const place of PLACES) assert.ok(ICON_NAMES.includes(place.icon), place.icon);

  assert.deepEqual(toLocation('pc'), { type: 'page', id: 'pc' });
  assert.deepEqual(toLocation('documents'), { type: 'place', id: 'documents' });
  assert.deepEqual(toLocation({ type: 'place', id: 'music' }), { type: 'place', id: 'music' });
  assert.deepEqual(toLocation({ type: 'page', id: 'trash' }), { type: 'page', id: 'trash' });
  assert.deepEqual(toLocation({ path: 'C:\\Users\\Léo' }), { type: 'folder', path: 'C:\\Users\\Léo', name: 'Léo' });
  assert.deepEqual(toLocation({ path: '/home/leo/', name: '' }), { type: 'folder', path: '/home/leo/', name: 'leo' });
  assert.deepEqual(toLocation({ path: 'D:\\', name: 'Lecteur (D:)' }), { type: 'folder', path: 'D:\\', name: 'Lecteur (D:)' });
  // Toute désignation inconnue mène à l'accueil — jamais à une page inventée.
  for (const unknown of [undefined, null, '', 'inconnu', 'constructor', '__proto__', 'toString', 42, {}, { type: 'page', id: 'secret' }, { type: 'place', id: 'x' }, { path: '' }, { path: 7 }]) {
    assert.deepEqual(toLocation(unknown), { type: 'page', id: 'home' }, String(unknown));
  }

  assert.equal(locationKey(toLocation('pc')), 'page:pc');
  assert.equal(locationKey(toLocation('music')), 'place:music');
  assert.equal(locationKey(toLocation({ path: 'C:\\Users' })), 'folder:C:\\Users');
});

test('nom d’un lecteur : la lettre, et « Disque local » pour celui du système', () => {
  assert.equal(driveName({ letter: 'C', system: true }), 'Disque local (C:)');
  assert.equal(driveName({ letter: 'D', system: false }), 'Lecteur (D:)');
  assert.equal(driveName({ letter: null, system: false }), 'Ordinateur');
});

test('éléments affichés : sans les éléments masqués, et filtrés sans tenir compte de la casse ni des accents', () => {
  const nodes = [{ name: 'Résumé été.pdf' }, { name: 'RESUME.TXT' }, { name: 'desktop.ini', hidden: true }, { name: 'Autre' }];
  assert.deepEqual(visibleNodes(nodes).map((node) => node.name), ['Résumé été.pdf', 'RESUME.TXT', 'Autre']);
  assert.equal(visibleNodes(nodes, { showHidden: true }).length, 4);
  assert.deepEqual(visibleNodes(nodes, { filter: 'resume' }).map((node) => node.name), ['Résumé été.pdf', 'RESUME.TXT']);
  assert.deepEqual(visibleNodes(nodes, { filter: '  ÉTÉ ' }).map((node) => node.name), ['Résumé été.pdf']);
  assert.deepEqual(visibleNodes(nodes, { filter: 'ini' }), []);
  assert.deepEqual(visibleNodes(nodes, { filter: 'ini', showHidden: true }).map((node) => node.name), ['desktop.ini']);
});

// ---------------------------------------------------------------------------------
// Sans l'application de bureau
// ---------------------------------------------------------------------------------

test('dans un navigateur : chaque emplacement annonce que les fichiers ne sont pas lisibles, sans rien inventer', async () => {
  const { nav, files } = createNavigator({ available: false });
  for (const location of [...LOCATION_IDS, { path: 'C:\\Users' }]) {
    await nav.open(location);
    assert.equal(nav.page.kind, 'preview', JSON.stringify(location));
    assert.deepEqual(nav.page.sections, []);
    assert.match(nav.page.message.title, /nécessite l'application Windows/);
    assert.match(nav.page.message.text, /Aucun fichier fictif/);
    assert.ok(ICON_NAMES.includes(nav.page.message.glyph));
  }
  assert.deepEqual(files.calls, [], 'le service n’est jamais sollicité');
  assert.deepEqual(nav.drives, []);
});

test('l’explorateur n’utilise plus aucun contenu d’exemple', () => {
  for (const file of ['apps/explorer.js', 'apps/explorer-nav.js', 'core/file-types.js']) {
    const code = stripComments(readText('src', 'renderer', 'js', ...file.split('/')));
    assert.doesNotMatch(code, /demo-files|demo-content|createDemoFileSystem|WALLPAPER_FILE/, file);
  }
  // L'interface ne lit pas le disque elle-même : elle passe par le service « files ».
  const explorer = stripComments(readText('src', 'renderer', 'js', 'apps', 'explorer.js'));
  assert.deepEqual([...explorer.matchAll(/services\.call\('(\w+)', '(\w+)'/g)].map((match) => `${match[1]}.${match[2]}`).sort(), ['files.list', 'files.places']);
});

// ---------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------

test('« Accueil » et « Ce PC » : dossiers personnels (indisponibles signalés) et lecteurs réels', async () => {
  const { nav, files } = createNavigator();
  await nav.open('home');
  assert.deepEqual([nav.page.kind, nav.page.title, nav.page.active, nav.page.up], ['home', 'Accueil', 'home', null]);
  assert.deepEqual(labels(nav.page), ['Accueil']);
  assert.deepEqual(nav.page.sections.map((section) => [section.title, section.layout]), [['Accès rapide', 'grid']]);
  assert.deepEqual(names(nav.page), ['Bureau', 'Documents', 'Images', 'Musique', 'Téléchargements', 'Vidéos']);
  const places = nav.page.sections[0].nodes;
  assert.deepEqual(places.map((node) => node.available), [true, true, true, false, true, false]);
  assert.deepEqual(places.map((node) => node.id), ['place:desktop', 'place:documents', 'place:pictures', 'place:music', 'place:downloads', 'place:videos']);
  assert.deepEqual(places[1].location, { type: 'place', id: 'documents' });

  await nav.open('pc');
  assert.deepEqual([nav.page.kind, nav.page.title, nav.page.active], ['pc', 'Ce PC', 'pc']);
  assert.deepEqual(nav.page.sections.map((section) => [section.title, section.layout]), [['Dossiers', 'collection'], ['Périphériques et lecteurs', 'drives']]);
  const drives = nav.page.sections[1].nodes;
  assert.deepEqual(drives.map((node) => [node.id, node.kind, node.name]), [['drive:C:', 'drive', 'Disque local (C:)'], ['drive:D:', 'drive', 'Lecteur (D:)']]);
  assert.deepEqual(drives[0].location, { type: 'folder', path: 'C:\\', name: 'Disque local (C:)' });
  assert.deepEqual([drives[0].totalBytes, drives[0].freeBytes, drives[1].totalBytes], [512e9, 128e9, null]);
  assert.deepEqual(nav.drives.map((node) => node.id), ['drive:C:', 'drive:D:']);

  // Ces deux pages montrent les lecteurs : ils sont recherchés à chaque affichage.
  assert.deepEqual(files.calls, [['places'], ['places']]);
});

test('« Réseau » et « Corbeille » : annoncés comme non disponibles, sans contenu', async () => {
  const { nav } = createNavigator();
  for (const [id, title] of [['network', 'Réseau non disponible'], ['trash', 'Corbeille non disponible']]) {
    await nav.open(id);
    assert.deepEqual([nav.page.kind, nav.page.message.title, nav.page.active], ['info', title, id]);
    assert.deepEqual(nav.page.sections, []);
    assert.equal(nav.page.code, undefined);
  }
});

test('dossier personnel : désigné par son chemin réel, présenté sous son nom habituel', async () => {
  const { nav, files } = createNavigator();
  await nav.open('documents');
  const { page } = nav;
  assert.deepEqual([page.kind, page.title, page.active, page.key], ['folder', 'Documents', 'place:documents', `folder:${DOCUMENTS}`]);
  assert.deepEqual(labels(page), ['Ce PC', 'Documents']);
  assert.deepEqual(page.location, { type: 'folder', path: DOCUMENTS, name: 'Documents' });
  assert.deepEqual(page.up, { type: 'page', id: 'pc' });
  assert.deepEqual(page.crumbs[0].location, { type: 'page', id: 'pc' });
  assert.deepEqual(page.crumbs[1].location, { type: 'folder', path: DOCUMENTS, name: 'Documents' });
  assert.deepEqual([page.truncated, page.limit, page.message], [false, 5000, null]);
  assert.deepEqual(files.calls, [['places'], ['list', DOCUMENTS]]);

  // Dossier personnel introuvable : une erreur claire, sans appel au service.
  await nav.open('music');
  assert.deepEqual([nav.page.kind, nav.page.code, nav.page.title, nav.page.active], ['error', 'place-unavailable', 'Musique', 'place:music']);
  assert.deepEqual(labels(nav.page), ['Ce PC', 'Musique']);
  assert.equal(files.calls.filter(([name]) => name === 'list').length, 1);
});

test('dossier personnel absent : un message le nomme et précise que rien n’est créé — aucune demande au service', async () => {
  // Aucun des six dossiers n'existe sur cet ordinateur.
  const known = { places: PLACES.map((place) => ({ id: place.id, path: null, available: false })), drives: KNOWN.drives };
  const { nav, files } = createNavigator({ known });

  for (const place of PLACES) {
    await nav.open(place.id);
    const { page } = nav;
    assert.deepEqual([page.kind, page.code, page.title, page.active], ['error', 'place-unavailable', place.name, `place:${place.id}`]);
    assert.deepEqual(labels(page), ['Ce PC', place.name]);
    assert.deepEqual(page.sections, []);
    assert.equal(page.location, undefined, 'aucun dossier réel n’est affiché');
    assert.deepEqual(page.up, { type: 'page', id: 'pc' });

    // Le message nomme le dossier, dit pourquoi il peut manquer, et que rien n'a été créé.
    assert.equal(page.message.title, `Dossier « ${place.name} » introuvable`);
    assert.ok(page.message.text.startsWith(`Windows n'indique aucun dossier « ${place.name} » sur cet ordinateur`), page.message.text);
    assert.match(page.message.text, /supprimé ou déplacé/);
    assert.match(page.message.text, /lecteur débranché ou sur le réseau/);
    assert.match(page.message.text, /Evolve ne crée jamais de dossier à votre place : rien n'a été modifié\.$/);
    assert.ok(ICON_NAMES.includes(page.message.glyph), page.message.glyph);
    // C'est ce message que la compilation attend de l'exécutable lancé sans dossier Documents (scripts/check-documents.mjs).
    if (place.id === 'documents') assert.equal(page.message.title, documentsTest.MESSAGE_TITLE);
    assert.ok(page.message.text.includes(documentsTest.NOTHING_CREATED), page.message.text);
  }
  // L'interface n'a rien demandé d'autre au service que la liste des emplacements.
  assert.deepEqual([...new Set(files.calls.map(([name]) => name))], ['places']);

  // La navigation continue : précédent, dossier parent, puis l'accueil, où le dossier figure comme absent.
  await nav.goBack();
  assert.equal(nav.page.title, 'Téléchargements');
  await nav.goUp();
  assert.equal(nav.page.title, 'Ce PC');
  await nav.open('home');
  assert.deepEqual(nav.page.sections[0].nodes.map((node) => node.available), [false, false, false, false, false, false]);
  // Actualiser l'accueil relance la recherche des emplacements — sans jamais rien demander d'autre.
  await nav.refresh();
  assert.deepEqual([...new Set(files.calls.map(([name]) => name))], ['places']);
});

test('dossier personnel disparu pendant la session : « Dossier introuvable », puis signalé absent après actualisation', async () => {
  const { nav, files } = createNavigator();
  await nav.open('documents');
  assert.equal(nav.page.kind, 'folder');

  // Le dossier est supprimé : sa lecture échoue, la recherche des emplacements ne le trouve plus.
  files.failures[DOCUMENTS] = 'not-found';
  await nav.refresh();
  assert.deepEqual([nav.page.kind, nav.page.code, nav.page.message.title], ['error', 'not-found', 'Dossier introuvable']);

  files.known = { ...KNOWN, places: KNOWN.places.map((place) => (place.id === 'documents' ? { id: 'documents', path: null, available: false } : place)) };
  await nav.open('home');
  await nav.open('documents');
  assert.deepEqual([nav.page.kind, nav.page.code, nav.page.message.title], ['error', 'place-unavailable', 'Dossier « Documents » introuvable']);
  // Aucune lecture n'est tentée pour un dossier que le système ne connaît plus.
  assert.equal(files.calls.filter(([name, target]) => name === 'list' && target === DOCUMENTS).length, 2);
});

test('dossier personnel absent puis revenu : « Actualiser » l’affiche, et l’historique mène à son contenu', async () => {
  const absent = { ...KNOWN, places: KNOWN.places.map((place) => (place.id === 'documents' ? { id: 'documents', path: null, available: false } : place)) };
  const { nav, files } = createNavigator({ known: absent });
  await nav.open('home');
  assert.equal(nav.page.sections[0].nodes.find((node) => node.id === 'place:documents').available, false);
  await nav.open('documents');
  assert.deepEqual([nav.page.kind, nav.page.code], ['error', 'place-unavailable']);
  // Actualiser tant qu'il est absent : le même message, sans aucune tentative de lecture.
  await nav.refresh();
  assert.deepEqual([nav.page.kind, nav.page.code], ['error', 'place-unavailable']);
  assert.equal(files.calls.filter(([name]) => name === 'list').length, 0);

  // Le dossier revient (dossier restauré, disque rebranché) : l'actualisation le trouve et affiche son contenu.
  files.known = KNOWN;
  await nav.refresh();
  assert.deepEqual([nav.page.kind, nav.page.title, nav.page.location.path], ['folder', 'Documents', DOCUMENTS]);
  assert.deepEqual(labels(nav.page), ['Ce PC', 'Documents']);
  assert.ok(names(nav.page).includes('Projets'));

  // « Précédent » ramène à l'accueil, où il n'est plus estompé ; « Suivant » revient à son contenu.
  await nav.goBack();
  assert.equal(nav.page.kind, 'home');
  assert.equal(nav.page.sections[0].nodes.find((node) => node.id === 'place:documents').available, true);
  await nav.goForward();
  assert.deepEqual([nav.page.kind, nav.page.location.path], ['folder', DOCUMENTS]);
});

test('éléments d’un dossier : identifiant, nature, extension, taille, date, et destination des dossiers et des liens', async () => {
  const { nav } = createNavigator();
  await nav.open('documents');
  const nodes = Object.fromEntries(nav.page.sections[0].nodes.map((node) => [node.name, node]));
  assert.deepEqual(nav.page.sections.map((section) => [section.title, section.layout]), [[null, 'collection']]);

  assert.deepEqual(nodes.Projets, {
    id: `${DOCUMENTS}\\Projets`,
    kind: 'folder',
    name: 'Projets',
    ext: '',
    size: null,
    modified: new Date(Date.UTC(2026, 2, 14)),
    hidden: false,
    location: { type: 'folder', path: `${DOCUMENTS}\\Projets`, name: 'Projets' },
  });
  const sheet = nodes['Budget 2026.xlsx'];
  assert.deepEqual([sheet.kind, sheet.ext, sheet.size, sheet.hidden], ['file', 'xlsx', 48_300, false]);
  assert.equal(Object.hasOwn(sheet, 'location'), false, 'un fichier ne s’ouvre pas : aucune destination');
  // Un lien s'ouvre comme un dossier : c'est le service qui vérifie où il mène.
  assert.deepEqual([nodes['Mes images'].kind, nodes['Mes images'].hidden], ['link', true]);
  assert.deepEqual(nodes['Mes images'].location, { type: 'folder', path: `${DOCUMENTS}\\Mes images`, name: 'Mes images' });
  assert.equal(nodes['desktop.ini'].hidden, true);
});

test('dossier d’un lecteur : fil d’Ariane complet, dossiers personnels sous leur nom habituel, liste tronquée signalée', async () => {
  const { nav } = createNavigator();
  await nav.open({ path: PROFILE });
  const { page } = nav;
  assert.deepEqual(labels(page), ['Ce PC', 'Disque local (C:)', 'Users', 'Léo']);
  assert.deepEqual(page.crumbs.map((crumb) => crumb.location.path ?? crumb.location.id), ['pc', 'C:\\', 'C:\\Users', PROFILE]);
  assert.deepEqual([page.title, page.active, page.truncated, page.limit], ['Léo', 'drive:C:', true, 3]);
  assert.deepEqual(page.up, { type: 'folder', path: 'C:\\Users', name: 'Users' });
  // « Desktop » et « Documents » portent leur nom et leur pictogramme habituels ; leur identifiant reste le chemin.
  const [desktop, documents, appData] = page.sections[0].nodes;
  assert.deepEqual([desktop.name, desktop.id, desktop.icon], ['Bureau', `${PROFILE}\\Desktop`, 'desktop']);
  assert.deepEqual([documents.name, documents.icon], ['Documents', 'file-text']);
  assert.deepEqual(documents.location, { type: 'folder', path: DOCUMENTS, name: 'Documents' });
  assert.deepEqual([appData.name, appData.hidden, Object.hasOwn(appData, 'icon')], ['AppData', true, false]);

  // Racine d'un lecteur : son nom vient de la liste des lecteurs.
  await nav.open({ path: 'D:\\' });
  assert.deepEqual([labels(nav.page), nav.page.title, nav.page.active], [['Ce PC', 'Lecteur (D:)'], 'Lecteur (D:)', 'drive:D:']);
  assert.deepEqual(nav.page.up, { type: 'page', id: 'pc' });
});

test('lecteur absent de la liste connue : nommé d’après sa lettre', async () => {
  const { nav } = createNavigator({ known: { ...KNOWN, drives: [] } });
  await nav.open({ path: 'C:\\' });
  assert.deepEqual(labels(nav.page), ['Ce PC', 'Lecteur (C:)']);
});

test('le dossier affiché est celui que le service a réellement lu (lien résolu)', async () => {
  const { nav } = createNavigator();
  await nav.open('documents');
  await nav.open({ path: `${DOCUMENTS}\\Mes images`, name: 'Mes images' });
  assert.deepEqual(nav.page.location, { type: 'folder', path: `${PROFILE}\\Pictures`, name: 'Images' });
  assert.deepEqual([nav.page.title, nav.page.active, labels(nav.page)], ['Images', 'place:pictures', ['Ce PC', 'Images']]);
  // L'historique retient la destination réelle : y revenir ne repasse pas par le lien.
  await nav.goBack();
  assert.equal(nav.page.key, `folder:${DOCUMENTS}`);
  await nav.goForward();
  assert.equal(nav.page.key, `folder:${PROFILE}\\Pictures`);
});

// ---------------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------------

test('précédent, suivant, dossier parent', async () => {
  const { nav } = createNavigator();
  assert.deepEqual([nav.page, nav.loading, nav.canGoBack, nav.canGoForward], [null, false, false, false]);
  await nav.goBack();
  await nav.goForward();
  await nav.goUp();
  await nav.refresh();
  assert.equal(nav.page, null, 'rien à faire avant le premier emplacement');

  await nav.open('home');
  assert.deepEqual([nav.canGoBack, nav.canGoForward], [false, false]);
  await nav.open('documents');
  await nav.open({ path: `${DOCUMENTS}\\Projets` });
  assert.deepEqual(labels(nav.page), ['Ce PC', 'Documents', 'Projets']);
  assert.deepEqual([nav.canGoBack, nav.canGoForward], [true, false]);

  await nav.goBack();
  assert.equal(nav.page.title, 'Documents');
  assert.deepEqual([nav.canGoBack, nav.canGoForward], [true, true]);
  await nav.goBack();
  assert.equal(nav.page.title, 'Accueil');
  assert.deepEqual([nav.canGoBack, nav.canGoForward], [false, true]);
  await nav.goBack();
  assert.equal(nav.page.title, 'Accueil', 'aucun effet au début de l’historique');

  await nav.goForward();
  await nav.goForward();
  assert.equal(nav.page.title, 'Projets');
  await nav.goForward();
  assert.equal(nav.page.title, 'Projets', 'aucun effet à la fin de l’historique');

  // Dossier parent : un pas dans le fil d'Ariane, inscrit dans l'historique.
  await nav.goUp();
  assert.equal(nav.page.title, 'Documents');
  await nav.goUp();
  assert.equal(nav.page.title, 'Ce PC');
  await nav.goUp();
  assert.equal(nav.page.title, 'Ce PC', '« Ce PC » n’a pas de parent');
  await nav.goBack();
  assert.equal(nav.page.title, 'Documents');
});

test('ouvrir un nouvel emplacement efface la suite de l’historique ; rouvrir le même ne l’allonge pas', async () => {
  const { nav } = createNavigator();
  await nav.open('home');
  await nav.open('documents');
  await nav.open('pc');
  await nav.goBack();
  await nav.goBack();
  assert.equal(nav.canGoForward, true);
  await nav.open('network');
  assert.equal(nav.canGoForward, false);
  await nav.goBack();
  assert.equal(nav.page.title, 'Accueil');

  // Le même emplacement, désigné par son nom ou par son chemin : une seule entrée.
  await nav.open('documents');
  await nav.open('documents');
  await nav.open({ path: DOCUMENTS });
  await nav.goBack();
  assert.equal(nav.page.title, 'Accueil');
  assert.equal(nav.canGoBack, false);
});

test('chaque changement est annoncé : lecture en cours, puis page prête', async () => {
  const { nav, states } = createNavigator();
  await nav.open('documents');
  assert.deepEqual(states, ['chargement', `folder:${DOCUMENTS}`]);
  assert.equal(nav.loading, false);
  await nav.refresh();
  assert.deepEqual(states.slice(2), ['chargement', `folder:${DOCUMENTS}`]);
});

test('actualiser relit le dossier et recherche de nouveau les lecteurs', async () => {
  const { nav, files } = createNavigator();
  await nav.open('documents');
  await nav.open({ path: `${DOCUMENTS}\\Projets` });
  assert.deepEqual(files.calls, [['places'], ['list', DOCUMENTS], ['list', `${DOCUMENTS}\\Projets`]], 'les lecteurs ne sont pas recherchés à chaque dossier');

  // Un lecteur a été branché entre-temps.
  files.known = { ...KNOWN, drives: [...KNOWN.drives, { id: 'E:', letter: 'E', path: 'E:\\', system: false, totalBytes: null, freeBytes: null }] };
  await nav.refresh();
  assert.deepEqual(files.calls.slice(3), [['places'], ['list', `${DOCUMENTS}\\Projets`]]);
  assert.deepEqual(nav.drives.map((node) => node.name), ['Disque local (C:)', 'Lecteur (D:)', 'Lecteur (E:)']);
  assert.equal(nav.canGoBack, true, 'actualiser ne modifie pas l’historique');
  await nav.goBack();
  assert.equal(nav.page.title, 'Documents');
});

test('une réponse tardive est ignorée : seule la dernière demande compte', async () => {
  const slow = `${DOCUMENTS}\\Projets`;
  const { nav, files, states } = createNavigator({ gates: [slow] });
  await nav.open('documents');
  const first = nav.open({ path: slow }); // lecture lente
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nav.loading, true);
  await nav.open('pc'); // l'utilisateur va ailleurs sans attendre
  assert.equal(nav.page.title, 'Ce PC');

  files.release(slow);
  await first;
  assert.equal(nav.page.title, 'Ce PC', 'la réponse tardive ne remplace pas la page affichée');
  assert.equal(nav.loading, false);
  assert.equal(states.at(-1), 'page:pc');
  // L'historique reste cohérent : Documents → Projets → Ce PC.
  const back = nav.goBack();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nav.loading, true);
  files.release(slow);
  await back;
  assert.deepEqual([nav.page.title, nav.canGoBack, nav.canGoForward], ['Projets', true, true]);
});

// ---------------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------------

test('chaque refus du service a son message ; un code inconnu donne « Lecture impossible »', async () => {
  const expected = {
    'access-denied': 'Accès refusé',
    'not-found': 'Dossier introuvable',
    'not-a-directory': "Cet élément n'est pas un dossier",
    'outside-allowed': 'Emplacement indisponible',
    'leads-outside': 'Emplacement non autorisé',
    'invalid-path': 'Emplacement non pris en charge',
    unavailable: 'Emplacement indisponible',
  };
  for (const [code, title] of Object.entries(expected)) {
    const { nav } = createNavigator({ failures: { 'C:\\Cible': code } });
    await nav.open({ path: 'C:\\Cible' });
    assert.deepEqual([nav.page.kind, nav.page.code, nav.page.message.title], ['error', code, title]);
    assert.ok(nav.page.message.text.length > 20);
    assert.ok(ICON_NAMES.includes(nav.page.message.glyph), nav.page.message.glyph);
    assert.deepEqual(nav.page.sections, []);
    assert.equal(nav.page.location, undefined, 'aucun dossier réel n’est affiché');
  }
  // Code inconnu, code qui n'est pas un texte, erreur sans code : même message général.
  const unknown = ['failed', 'bad-arguments', 'unknown-method', 'constructor', '__proto__', 'toString', new Error('sans code'), Object.assign(new Error('code numérique'), { code: 42 }), new TypeError('panne')];
  for (const failure of unknown) {
    const { nav } = createNavigator({ failures: { 'C:\\Cible': failure } });
    await nav.open({ path: 'C:\\Cible' });
    assert.deepEqual([nav.page.kind, nav.page.code, nav.page.message.title], ['error', 'failed', 'Lecture impossible'], String(failure));
  }
});

test('dossier inaccessible ouvert depuis son parent : le fil d’Ariane le situe, et la navigation continue', async () => {
  const denied = `${DOCUMENTS}\\Privé`;
  const { nav } = createNavigator({ failures: { [denied]: 'access-denied' } });
  await nav.open('documents');
  await nav.open({ path: denied, name: 'Privé' });
  assert.deepEqual([nav.page.kind, nav.page.code, nav.page.title], ['error', 'access-denied', 'Privé']);
  assert.deepEqual(labels(nav.page), ['Ce PC', 'Documents', 'Privé']);
  assert.equal(nav.page.active, 'place:documents');
  assert.deepEqual(nav.page.up, { type: 'folder', path: DOCUMENTS, name: 'Documents' });

  // Dossier parent, puis précédent/suivant : rien n'est bloqué.
  await nav.goUp();
  assert.equal(nav.page.title, 'Documents');
  await nav.goBack();
  assert.equal(nav.page.code, 'access-denied');
  await nav.goBack();
  assert.equal(nav.page.title, 'Documents');
  assert.equal(nav.canGoForward, true);
});

test('dossier inaccessible ouvert sans contexte : fil d’Ariane minimal', async () => {
  const { nav } = createNavigator({ failures: { 'D:\\Secret': 'access-denied' } });
  await nav.open({ path: 'D:\\Secret' });
  assert.deepEqual(labels(nav.page), ['Ce PC', 'Secret']);
  assert.equal(nav.page.active, null);
  assert.deepEqual(nav.page.up, { type: 'page', id: 'pc' });
});

test('dossier disparu pendant qu’il est affiché : l’actualisation l’annonce, à sa place dans le fil d’Ariane', async () => {
  const folder = `${DOCUMENTS}\\Projets`;
  const { nav, files } = createNavigator();
  await nav.open('documents');
  await nav.open({ path: folder });
  files.failures[folder] = 'not-found';
  await nav.refresh();
  assert.deepEqual([nav.page.kind, nav.page.code], ['error', 'not-found']);
  assert.deepEqual(labels(nav.page), ['Ce PC', 'Documents', 'Projets']);
  assert.equal(nav.page.active, 'place:documents');
  // Le dossier réapparaît : une nouvelle actualisation l'affiche.
  delete files.failures[folder];
  await nav.refresh();
  assert.deepEqual([nav.page.kind, nav.page.title], ['folder', 'Projets']);
});

test('recherche des emplacements en échec : une erreur est affichée, jamais d’exception', async () => {
  const { nav, files } = createNavigator({ failures: { places: 'failed' } });
  await nav.open('pc');
  assert.deepEqual([nav.page.kind, nav.page.code, nav.page.title], ['error', 'failed', 'Ce PC']);
  assert.deepEqual(nav.drives, []);
  delete files.failures.places;
  await nav.refresh();
  assert.equal(nav.page.kind, 'pc');
  assert.equal(nav.page.sections[1].nodes.length, 2);
});

// ---------------------------------------------------------------------------------
// Types de fichiers
// ---------------------------------------------------------------------------------

test('types de fichiers : libellé, pictogramme existant et teinte pour chaque extension', () => {
  const tones = new Set(['violet', 'magenta', 'blue', 'cyan', 'green', 'amber', 'red']);
  assert.ok(Object.keys(FILE_TYPES).length >= 90);
  for (const [ext, type] of Object.entries(FILE_TYPES)) {
    assert.match(ext, /^[a-z0-9]+$/, ext);
    assert.ok(type.label.length >= 5, ext);
    assert.ok(ICON_NAMES.includes(type.icon), `${ext} : pictogramme ${type.icon}`);
    assert.ok(tones.has(type.tone), `${ext} : teinte ${type.tone}`);
  }
  assert.ok(Object.isFrozen(FILE_TYPES) && Object.isFrozen(FILE_TYPES.pdf));
  assert.equal(FILE_TYPES.png.label, 'Image PNG');
  assert.equal(FILE_TYPES.mp3.label, 'Audio MP3');
  assert.equal(FILE_TYPES.exe.label, 'Application');
  assert.equal(FILE_TYPES.lnk.label, 'Raccourci');

  assert.equal(extensionOf('Rapport final.DOCX'), 'docx');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('.gitignore'), '', 'un nom qui commence par un point n’a pas d’extension');
  assert.equal(extensionOf('sans extension'), '');
  assert.equal(extensionOf('point final.'), '');
});

test('description d’un élément selon sa nature', () => {
  assert.equal(describeNode({ kind: 'file', ext: 'pdf' }).label, 'Document PDF');
  assert.deepEqual(describeNode({ kind: 'file', ext: 'inconnu' }), { label: 'Fichier', icon: 'file', tone: 'violet' });
  // Extension qui porte le nom d'une propriété d'objet : un simple fichier.
  for (const ext of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '']) {
    assert.equal(describeNode({ kind: 'file', ext }).label, 'Fichier', ext);
  }
  assert.deepEqual(describeNode({ kind: 'folder' }), { label: 'Dossier de fichiers', icon: 'folder', tone: 'violet' });
  assert.equal(describeNode({ kind: 'folder', icon: 'images' }).icon, 'images');
  assert.equal(describeNode({ kind: 'drive' }).label, 'Disque local');
  assert.equal(describeNode({ kind: 'link' }).label, 'Lien');
  assert.equal(describeNode({ kind: 'other' }).label, 'Élément système');
  for (const kind of ['file', 'folder', 'drive', 'link', 'other', 'place']) {
    assert.ok(ICON_NAMES.includes(describeNode({ kind, ext: '' }).icon), kind);
  }
  assert.deepEqual(['folder', 'drive', 'place', 'file', 'link', 'other'].map((kind) => isContainer({ kind })), [true, true, true, false, false, false]);
});

test('tri : dossiers d’abord, ordre naturel des nombres, accents et casse ignorés', () => {
  const nodes = [
    { name: 'fichier 10.txt', kind: 'file', ext: 'txt', size: 10, modified: new Date(2026, 0, 3) },
    { name: 'Élan.pdf', kind: 'file', ext: 'pdf', size: 300, modified: new Date(2026, 0, 1) },
    { name: 'fichier 2.txt', kind: 'file', ext: 'txt', size: 2, modified: new Date(2026, 0, 2) },
    { name: 'zoo', kind: 'folder', size: null, modified: new Date(2026, 0, 5) },
    { name: 'eau.txt', kind: 'file', ext: 'txt', size: null, modified: null },
    { name: 'Archives', kind: 'folder', size: null, modified: new Date(2026, 0, 4) },
    { name: 'lien', kind: 'link', size: null, modified: new Date(2026, 0, 6) },
  ];
  const order = (key, direction) => sortNodes(nodes, key, direction).map((node) => node.name);

  assert.deepEqual(order('name', 1), ['Archives', 'zoo', 'eau.txt', 'Élan.pdf', 'fichier 2.txt', 'fichier 10.txt', 'lien']);
  assert.deepEqual(order('name', -1), ['zoo', 'Archives', 'lien', 'fichier 10.txt', 'fichier 2.txt', 'Élan.pdf', 'eau.txt']);
  assert.deepEqual(order('size', 1), ['Archives', 'zoo', 'eau.txt', 'lien', 'fichier 2.txt', 'fichier 10.txt', 'Élan.pdf']);
  assert.deepEqual(order('modified', -1), ['zoo', 'Archives', 'lien', 'fichier 10.txt', 'fichier 2.txt', 'Élan.pdf', 'eau.txt']);
  assert.deepEqual(order('type', 1), ['Archives', 'zoo', 'Élan.pdf', 'eau.txt', 'fichier 2.txt', 'fichier 10.txt', 'lien']);
  assert.deepEqual(order('inconnu', 1), order('name', 1), 'clé inconnue : tri par nom');
  assert.deepEqual(order(), order('name', 1));
  assert.equal(nodes[0].name, 'fichier 10.txt', 'la liste d’origine n’est pas modifiée');
});
