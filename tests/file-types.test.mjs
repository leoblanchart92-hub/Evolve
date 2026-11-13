/** Types de fichiers et tri des éléments (core/file-types.js). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeNode, extensionOf, FILE_TYPES, isContainer, sortNodes } from '../src/renderer/js/core/file-types.js';

const at = (day) => new Date(2026, 10, day, 9, 0, 0);
const folder = (name, day) => ({ kind: 'folder', name, modified: at(day) });
const file = (name, size, day) => ({ kind: 'file', name, ext: extensionOf(name), size, modified: at(day) });

/** Contenu d'un dossier : trois dossiers, cinq fichiers. */
const CHILDREN = Object.freeze([
  file('Rapport annuel.docx', 31_000, 9),
  folder('Projets', 6),
  file('Budget 2026.xlsx', 48_300, 8),
  folder('Administratif', 2),
  file('Notes.txt', 412, 11),
  file('Guide de démarrage.pdf', 184_320, 1),
  folder('Factures', 10),
  file('Présentation Evolve.pptx', 5_872_025, 4),
]);

const names = (nodes) => nodes.map((node) => node.name);

test('chaque type de fichier connu a un libellé, un pictogramme et une teinte', () => {
  const extensions = Object.keys(FILE_TYPES);
  assert.ok(extensions.length > 80);
  for (const ext of extensions) {
    assert.match(ext, /^[a-z0-9]+$/, ext);
    const type = FILE_TYPES[ext];
    assert.ok(type.label && type.icon && type.tone, `type incomplet : .${ext}`);
    assert.ok(Object.isFrozen(type));
  }
  assert.equal(FILE_TYPES.png.label, 'Image PNG');
  assert.equal(FILE_TYPES.docx.label, 'Document');
  assert.equal(FILE_TYPES.exe.label, 'Application');
});

test('description des éléments : libellé, pictogramme, teinte', () => {
  for (const node of [...CHILDREN, { kind: 'drive', name: 'C:' }, { kind: 'link', name: 'Lien' }, { kind: 'other', name: 'Canal' }, { kind: 'page', name: 'Ce PC', icon: 'desktop' }]) {
    const info = describeNode(node);
    assert.ok(info.label && info.icon && info.tone, `description incomplète pour ${node.name}`);
  }
  assert.equal(describeNode(folder('Documents', 1)).label, 'Dossier de fichiers');
  assert.equal(describeNode({ kind: 'folder', name: 'Images', icon: 'images' }).icon, 'images');
  assert.equal(describeNode({ kind: 'file', name: 'x.inconnu', ext: 'inconnu' }).label, 'Fichier');
  // Une extension qui porte le nom d'une propriété d'objet n'est pas un type connu.
  assert.equal(describeNode({ kind: 'file', name: 'x.constructor', ext: 'constructor' }).label, 'Fichier');
  assert.equal(describeNode({ kind: 'link', name: 'Lien' }).label, 'Lien');
  assert.equal(describeNode({ kind: 'drive', name: 'C:' }).icon, 'hard-drive');
});

test('extension des noms de fichiers', () => {
  assert.equal(extensionOf('Rapport annuel.DOCX'), 'docx');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('sans-extension'), '');
  assert.equal(extensionOf('.cache'), '');
});

test('les dossiers et les lecteurs se rangent ensemble ; les fichiers et les liens aussi', () => {
  assert.equal(isContainer(folder('Projets', 1)), true);
  assert.equal(isContainer({ kind: 'drive', name: 'C:' }), true);
  assert.equal(isContainer(file('Notes.txt', 1, 1)), false);
  assert.equal(isContainer({ kind: 'link', name: 'Lien' }), false);
  assert.equal(isContainer({ kind: 'other', name: 'Canal' }), false);
});

test('tri : les dossiers restent en premier, dans les deux sens', () => {
  for (const key of ['name', 'modified', 'type', 'size', 'inconnue']) {
    for (const direction of [1, -1]) {
      const sorted = sortNodes(CHILDREN, key, direction);
      assert.equal(sorted.length, CHILDREN.length);
      const firstFile = sorted.findIndex((node) => !isContainer(node));
      assert.equal(firstFile, 3, `${key}, ${direction}`);
      assert.ok(sorted.slice(firstFile).every((node) => !isContainer(node)), `dossiers mêlés aux fichiers (${key}, ${direction})`);
    }
  }
});

test('tri par nom : ordre alphabétique français, nombres compris', () => {
  assert.deepEqual(names(sortNodes(CHILDREN, 'name', 1)), [
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

test('tri par taille, par date et par type', () => {
  const onlyFiles = CHILDREN.filter((node) => node.kind === 'file');
  const bySize = sortNodes(onlyFiles, 'size', -1).map((node) => node.size);
  assert.deepEqual(bySize, [...bySize].sort((a, b) => b - a));
  const byDate = sortNodes(onlyFiles, 'modified', 1).map((node) => node.modified.getTime());
  assert.deepEqual(byDate, [...byDate].sort((a, b) => a - b));
  // Par type : selon le libellé du type, puis le nom.
  assert.deepEqual(names(sortNodes(onlyFiles, 'type', 1)), ['Rapport annuel.docx', 'Guide de démarrage.pdf', 'Notes.txt', 'Budget 2026.xlsx', 'Présentation Evolve.pptx']);
  // Un élément sans taille ni date se trie sans erreur.
  assert.equal(sortNodes([{ kind: 'file', name: 'b' }, { kind: 'file', name: 'a' }], 'size', 1)[0].name, 'a');
  assert.equal(sortNodes([{ kind: 'file', name: 'b' }, { kind: 'file', name: 'a' }], 'modified', -1)[0].name, 'b');
});

test('le tri ne modifie pas la liste d’origine', () => {
  const before = [...CHILDREN];
  sortNodes(CHILDREN, 'size', -1);
  assert.deepEqual(CHILDREN, before);
});
