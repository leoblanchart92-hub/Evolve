/**
 * Arborescence d'exemple de l'explorateur de fichiers (aucun accès au disque).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDemoFileSystem,
  describeNode,
  extensionOf,
  FILE_TYPES,
  isContainer,
  sortNodes,
  WALLPAPER_FILE,
} from '../src/renderer/js/data/demo-files.js';

const now = new Date(2026, 10, 10, 9, 0, 0);
const files = createDemoFileSystem(now);

/** Tous les nœuds de l'arborescence (hors racine). */
function allNodes() {
  const nodes = [];
  (function walk(node) {
    for (const child of node.children ?? []) {
      nodes.push(child);
      walk(child);
    }
  })(files.root);
  return nodes;
}

test("l'arborescence est signalée comme contenu de démonstration", () => {
  assert.equal(files.isDemo, true);
});

test('chaque élément a un identifiant unique et retrouvable', () => {
  const nodes = allNodes();
  assert.ok(nodes.length > 50);
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
  for (const node of nodes) {
    assert.equal(files.get(node.id), node);
    assert.ok(node.name.length > 0);
    if (node.parent.kind !== 'root') assert.equal(node.id, `${node.parent.id}/${node.name}`);
  }
  assert.equal(files.get('inconnu'), undefined);
});

test('les emplacements principaux et les accès rapides existent', () => {
  for (const place of ['home', 'pc', 'network', 'trash', 'desktop', 'documents', 'pictures', 'music', 'downloads', 'videos']) {
    assert.ok(files.places[place], `emplacement « ${place} » manquant`);
    assert.ok(isContainer(files.places[place]));
  }
  assert.equal(files.places.documents, files.get('pc/Documents'));
  assert.deepEqual(
    files.get('pc').children.filter((node) => node.kind === 'drive').map((node) => node.letter),
    ['C', 'D'],
  );
});

test('les lecteurs annoncent un espace libre inférieur à leur capacité', () => {
  for (const drive of allNodes().filter((node) => node.kind === 'drive')) {
    assert.ok(drive.totalBytes > 0);
    assert.ok(drive.freeBytes > 0 && drive.freeBytes < drive.totalBytes, drive.name);
  }
});

test('chaque fichier a une taille, un type connu et une date passée', () => {
  const list = files.allFiles();
  assert.ok(list.length >= 30);
  for (const file of list) {
    assert.equal(file.kind, 'file');
    assert.ok(Number.isInteger(file.size) && file.size > 0, `taille de ${file.name}`);
    assert.equal(file.ext, extensionOf(file.name));
    assert.ok(FILE_TYPES[file.ext], `type inconnu pour ${file.name}`);
    assert.ok(file.modified instanceof Date && file.modified.getTime() <= now.getTime(), `date de ${file.name}`);
    assert.equal(isContainer(file), false);
  }
});

test("la date d'un dossier est celle de son contenu le plus récent", () => {
  const documents = files.get('pc/Documents');
  const latest = Math.max(...documents.children.map((child) => child.modified.getTime()));
  assert.equal(documents.modified.getTime(), latest);
  assert.ok(files.get('trash').modified.getTime() < now.getTime());
});

test("le fil d'Ariane part de l'emplacement racine", () => {
  const node = files.get('pc/Documents/Factures');
  assert.deepEqual(files.pathTo(node).map((item) => item.id), ['pc', 'pc/Documents', 'pc/Documents/Factures']);
  assert.deepEqual(files.pathTo(files.get('home')).map((item) => item.id), ['home']);
});

test('tri : les dossiers restent en premier, dans les deux sens', () => {
  const children = files.get('pc/Documents').children;
  for (const key of ['name', 'modified', 'type', 'size']) {
    for (const direction of [1, -1]) {
      const sorted = sortNodes(children, key, direction);
      assert.equal(sorted.length, children.length);
      const firstFile = sorted.findIndex((node) => !isContainer(node));
      assert.ok(firstFile > 0);
      assert.ok(sorted.slice(firstFile).every((node) => !isContainer(node)), `dossiers mêlés aux fichiers (${key}, ${direction})`);
    }
  }
});

test('tri par nom : ordre alphabétique français, nombres compris', () => {
  const names = (nodes) => nodes.map((node) => node.name);
  assert.deepEqual(names(sortNodes(files.get('pc/Documents').children, 'name', 1)), [
    'Administratif',
    'Factures',
    'Projets',
    'Budget 2026.xlsx',
    'Guide de démarrage.pdf',
    'Notes.txt',
    'Présentation Evolve.pptx',
    'Rapport annuel.docx',
  ]);
  const mixed = [
    { kind: 'file', name: 'Photo 10.png' },
    { kind: 'file', name: 'photo 2.png' },
    { kind: 'file', name: 'Édition.txt' },
    { kind: 'file', name: 'eau.txt' },
    { kind: 'file', name: 'Zèbre.txt' },
  ];
  assert.deepEqual(names(sortNodes(mixed, 'name', 1)), ['eau.txt', 'Édition.txt', 'photo 2.png', 'Photo 10.png', 'Zèbre.txt']);
  assert.deepEqual(names(sortNodes(mixed, 'name', -1)), ['Zèbre.txt', 'Photo 10.png', 'photo 2.png', 'Édition.txt', 'eau.txt']);
});

test('tri par taille et par date', () => {
  const onlyFiles = files.get('pc/Documents').children.filter((node) => node.kind === 'file');
  const bySize = sortNodes(onlyFiles, 'size', -1).map((node) => node.size);
  assert.deepEqual(bySize, [...bySize].sort((a, b) => b - a));
  const byDate = sortNodes(onlyFiles, 'modified', 1).map((node) => node.modified.getTime());
  assert.deepEqual(byDate, [...byDate].sort((a, b) => a - b));
});

test('le tri ne modifie pas la liste d’origine', () => {
  const children = files.get('pc/Documents').children;
  const before = [...children];
  sortNodes(children, 'size', -1);
  assert.deepEqual(children, before);
});

test('recherche insensible à la casse et aux accents', () => {
  assert.deepEqual(files.search('budget').map((node) => node.name), ['Budget 2026.xlsx']);
  assert.deepEqual(files.search('BUDGET').map((node) => node.name), ['Budget 2026.xlsx']);
  const names = files.search('presentation', 10).map((node) => node.name);
  assert.ok(names.includes('Présentation Evolve.pptx'));
  assert.ok(names.every((name) => /pr[ée]sentation/i.test(name)));
});

test('recherche : requête vide, sans résultat, limite', () => {
  assert.deepEqual(files.search(''), []);
  assert.deepEqual(files.search('   '), []);
  assert.deepEqual(files.search('zzzz-introuvable'), []);
  assert.equal(files.search('e', 3).length, 3);
  assert.ok(files.search('e', 100).length > 3);
});

test('les fichiers récents sont classés du plus récent au plus ancien', () => {
  const recents = files.recents(8);
  assert.equal(recents.length, 8);
  assert.ok(recents.every((node) => node.kind === 'file'));
  const times = recents.map((node) => node.modified.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const newest = Math.max(...files.allFiles().map((node) => node.modified.getTime()));
  assert.equal(times[0], newest);
});

test("le fond d'écran officiel figure dans « Images › Fonds d'écran »", () => {
  const node = files.get(`pc/Images/Fonds d'écran/${WALLPAPER_FILE.name}`);
  assert.ok(node);
  assert.equal(node.size, WALLPAPER_FILE.size);
  assert.equal(describeNode(node).label, 'Image PNG');
});

test('description des éléments : libellé, pictogramme, teinte', () => {
  for (const node of allNodes()) {
    const info = describeNode(node);
    assert.ok(info.label && info.icon && info.tone, `description incomplète pour ${node.id}`);
  }
  assert.equal(describeNode(files.get('pc/Documents')).label, 'Dossier de fichiers');
  assert.equal(describeNode({ kind: 'file', name: 'x.inconnu', ext: 'inconnu' }).label, 'Fichier');
});

test('extension des noms de fichiers', () => {
  assert.equal(extensionOf('Rapport annuel.DOCX'), 'docx');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('sans-extension'), '');
  assert.equal(extensionOf('.cache'), '');
});

test("l'arborescence se construit quel que soit l'instant de référence", () => {
  // La construction refuse les identifiants en double : elle ne doit jamais échouer.
  assert.doesNotThrow(() => createDemoFileSystem(new Date(2030, 0, 1)));
  assert.doesNotThrow(() => createDemoFileSystem());
  const later = createDemoFileSystem(new Date(2030, 0, 1, 12, 0, 0));
  const newest = Math.max(...later.allFiles().map((node) => node.modified.getTime()));
  assert.ok(newest <= new Date(2030, 0, 1, 12, 0, 0).getTime(), 'les dates suivent l’instant de référence');
  assert.ok(newest > new Date(2029, 11, 31).getTime());
});
