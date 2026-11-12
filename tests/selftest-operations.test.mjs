/**
 * Outils de l'auto-test des opérations sur les fichiers
 * (src/main/selftest-operations.js) : relevé du contenu d'un dossier, écarts
 * avec le contenu attendu, recherche d'un élément dans la Corbeille de Windows.
 *
 * Le scénario lui-même — gestes dans l'interface, contrôles sur le disque —
 * est éprouvé par tests/selftest.test.mjs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { ACCOUNT, recycle, recycleRecord } from './fixtures/recycle-bin.mjs';

const require = createRequire(import.meta.url);
const { ANY_FILE, CHECKS, DIRECTORY, LINK, NAMES, contentOf, differences, findRecycled, recycledPathOf } = require('../src/main/selftest-operations.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-operations-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let sequence = 0;
const freshDir = () => {
  const folder = path.join(workDir, `essai-${(sequence += 1)}`);
  mkdirSync(folder);
  return folder;
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('contenu d’un dossier : chaque élément par son chemin relatif — dossier, lien non suivi, ou empreinte du fichier', () => {
  const folder = freshDir();
  mkdirSync(path.join(folder, "Photos d'été", 'Plage'), { recursive: true });
  mkdirSync(path.join(folder, 'Vide'));
  writeFileSync(path.join(folder, 'Lettre à Zoé.txt'), 'bonjour');
  writeFileSync(path.join(folder, "Photos d'été", 'Plage', 'mer.jpg'), Buffer.alloc(2048, 7));
  writeFileSync(path.join(folder, 'vide.txt'), '');
  // Lien vers un dossier situé ailleurs : il est signalé, son contenu n'est pas relevé.
  const elsewhere = freshDir();
  writeFileSync(path.join(elsewhere, 'secret.txt'), 'secret');
  symlinkSync(elsewhere, path.join(folder, 'Lien'), 'junction');

  assert.deepEqual(contentOf(folder), {
    'Lettre à Zoé.txt': sha256('bonjour'),
    Lien: LINK,
    "Photos d'été": DIRECTORY,
    "Photos d'été/Plage": DIRECTORY,
    "Photos d'été/Plage/mer.jpg": sha256(Buffer.alloc(2048, 7)),
    Vide: DIRECTORY,
    'vide.txt': sha256(''),
  });
  assert.deepEqual(contentOf(path.join(folder, 'Vide')), {});
  assert.throws(() => contentOf(path.join(folder, 'Absent')), { code: 'ENOENT' });
  assert.deepEqual([DIRECTORY, LINK, ANY_FILE], ['dossier', 'lien', 'fichier']);
});

test('écarts entre le contenu attendu et le contenu réel : éléments manquants, inattendus, modifiés', () => {
  const expected = { 'a.txt': sha256('a'), Dossier: DIRECTORY, 'Dossier/b.txt': sha256('b') };
  assert.equal(differences(expected, { ...expected }), null);
  assert.equal(differences({}, {}), null);

  assert.deepEqual(differences(expected, { 'a.txt': sha256('a'), Dossier: DIRECTORY }), { manquants: ['Dossier/b.txt'], inattendus: [], modifies: [] });
  assert.deepEqual(differences(expected, { ...expected, 'c.txt': sha256('c') }), { manquants: [], inattendus: ['c.txt'], modifies: [] });
  assert.deepEqual(differences(expected, { ...expected, 'a.txt': sha256('A') }), { manquants: [], inattendus: [], modifies: ['a.txt'] });
  // Un fichier à la place d'un dossier, un lien à la place d'un fichier : modifiés.
  assert.deepEqual(differences(expected, { 'a.txt': LINK, Dossier: sha256(''), 'Dossier/b.txt': sha256('b') }), { manquants: [], inattendus: [], modifies: ['a.txt', 'Dossier'] });
  // Renommé : manquant sous un nom, inattendu sous l'autre.
  assert.deepEqual(differences(expected, { 'A.txt': sha256('a'), Dossier: DIRECTORY, 'Dossier/b.txt': sha256('b') }), { manquants: ['a.txt'], inattendus: ['A.txt'], modifies: [] });

  // « Un fichier, quel que soit son contenu » : ni un dossier, ni un lien, ni une absence.
  const loose = { 'temoin.txt': ANY_FILE };
  assert.equal(differences(loose, { 'temoin.txt': sha256('execute\r\n') }), null);
  assert.equal(differences(loose, { 'temoin.txt': sha256('') }), null);
  assert.deepEqual(differences(loose, { 'temoin.txt': DIRECTORY }), { manquants: [], inattendus: [], modifies: ['temoin.txt'] });
  assert.deepEqual(differences(loose, { 'temoin.txt': LINK }), { manquants: [], inattendus: [], modifies: ['temoin.txt'] });
  assert.deepEqual(differences(loose, {}), { manquants: ['temoin.txt'], inattendus: [], modifies: [] });
  // Un nom d'élément qui est aussi celui d'une propriété ordinaire ne trompe pas la comparaison.
  assert.deepEqual(differences({}, { constructor: DIRECTORY, toString: sha256('x') }), { manquants: [], inattendus: ['constructor', 'toString'], modifies: [] });
});

test('fiche de la Corbeille de Windows : emplacement d’origine lu dans les deux formats', () => {
  const original = "D:\\a\\Evolve\\self-test-output\\explorateur\\essai-AbC123\\Atelier d'essai été 2026\\À jeter";
  // Depuis Windows 10 : longueur du chemin, puis chemin. Avant : 260 caractères, complétés par des zéros.
  const recent = recycleRecord(original, { version: 2 });
  const older = recycleRecord(original, { version: 1 });
  assert.equal(recent.length, 28 + (original.length + 1) * 2);
  assert.equal(older.length, 544);
  assert.equal(recycledPathOf(recent), original);
  assert.equal(recycledPathOf(older), original);
  // Longueur annoncée trop grande, ou fiche tronquée : le chemin est lu jusqu'à son zéro final, sans dépasser la fiche.
  const padded = Buffer.concat([recent, Buffer.alloc(64)]);
  padded.writeUInt32LE(4000, 24);
  assert.equal(recycledPathOf(padded), original);
  assert.equal(recycledPathOf(recent.subarray(0, 28 + 10)), original.slice(0, 5));

  // Ce qui n'est pas une fiche : rien n'est inventé.
  const unknown = Buffer.from(recent);
  unknown.writeBigInt64LE(77n, 0);
  for (const record of [Buffer.alloc(0), Buffer.alloc(27), unknown, Buffer.alloc(28).fill(0), 'texte', null, undefined]) {
    assert.ok([null, ''].includes(recycledPathOf(record)), String(record));
  }
  assert.equal(recycledPathOf(Buffer.alloc(27)), null);
  assert.equal(recycledPathOf(unknown), null);
});

test('recherche dans la Corbeille : la fiche qui cite l’emplacement d’origine, et l’élément rangé à côté d’elle', () => {
  const bin = path.join(freshDir(), '$RECYCLE.BIN');
  const source = freshDir();
  const folder = path.join(source, 'À jeter');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'brouillon.txt'), 'brouillon');
  const file = path.join(source, 'Lettre à Zoé.txt');
  writeFileSync(file, 'lettre');
  const kept = path.join(source, 'Gardé.txt');
  writeFileSync(kept, 'gardé');

  // Corbeille absente, ou vide : rien.
  assert.equal(findRecycled(bin, folder), null);
  mkdirSync(bin);
  assert.equal(findRecycled(bin, folder), null);

  // D'autres éléments y sont déjà, dont un d'un autre compte ; un fichier traîne à la racine.
  const other = recycle(bin, kept, { account: 'S-1-5-21-1-2-3-500' });
  writeFileSync(path.join(bin, 'desktop.ini'), '');
  mkdirSync(path.join(bin, ACCOUNT), { recursive: true });
  writeFileSync(path.join(bin, ACCOUNT, '$IABCDEF.txt'), 'fiche illisible');
  writeFileSync(path.join(bin, ACCOUNT, 'desktop.ini'), '');
  assert.equal(findRecycled(bin, folder), null);
  assert.equal(findRecycled(bin, file), null);

  // Un dossier, puis un fichier (ancien format de fiche).
  const first = recycle(bin, folder);
  const second = recycle(bin, file, { version: 1 });
  assert.deepEqual(findRecycled(bin, folder), first);
  assert.deepEqual(findRecycled(bin, file), second);
  assert.deepEqual(findRecycled(bin, kept), other);
  assert.match(path.basename(first.record), /^\$I[0-9A-Z]{6}$/);
  assert.match(path.basename(second.record), /^\$I[0-9A-Z]{6}\.txt$/);
  assert.equal(path.basename(second.content), `$R${path.basename(second.record).slice(2)}`);
  assert.deepEqual(contentOf(first.content), { 'brouillon.txt': sha256('brouillon') });
  assert.deepEqual(readdirSync(source), []);

  // Windows ne distingue pas les majuscules ; un emplacement voisin n'est pas confondu.
  assert.deepEqual(findRecycled(bin, folder.toUpperCase()), first);
  assert.equal(findRecycled(bin, `${folder} 2`), null);
  assert.equal(findRecycled(bin, path.dirname(folder)), null);
  assert.equal(findRecycled(bin, path.join(folder, 'brouillon.txt')), null);

  // Fiche présente, élément disparu : signalé comme tel.
  rmSync(second.content);
  assert.deepEqual(findRecycled(bin, file), { record: second.record, content: null });
});

test('recherche dans la Corbeille : le dossier d’un autre compte, illisible, est simplement ignoré', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const bin = path.join(freshDir(), '$RECYCLE.BIN');
  const source = freshDir();
  const file = path.join(source, 'Lettre.txt');
  writeFileSync(file, 'lettre');
  const locked = path.join(bin, 'S-1-5-18');
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    assert.equal(findRecycled(bin, file), null);
    const found = recycle(bin, file);
    assert.deepEqual(findRecycled(bin, file), found);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('intitulés des contrôles et noms des éléments d’essai', () => {
  // Douze contrôles, aux intitulés tous différents ; chacun dit ce qui est constaté.
  const names = Object.values(CHECKS);
  assert.deepEqual(Object.keys(CHECKS), ['create', 'collision', 'rename', 'move', 'copy', 'trash', 'recycled', 'open', 'executed', 'unconfirmed', 'refused', 'state']);
  assert.equal(new Set(names).size, 12);
  assert.ok(Object.isFrozen(CHECKS) && Object.isFrozen(NAMES));
  // Les noms éprouvent les espaces, les accents et l'apostrophe ; chacun est un nom que Windows admet.
  for (const name of Object.values(NAMES)) {
    assert.doesNotMatch(name, /[\\/:*?"<>|]|^\s|[\s.]$/, name);
  }
  assert.ok(Object.values(NAMES).some((name) => name.includes("'")) && Object.values(NAMES).some((name) => /[éàçû]/.test(name)) && Object.values(NAMES).some((name) => name.includes(' ')));
  assert.equal(new Set(Object.values(NAMES)).size, Object.values(NAMES).length);
  // Le fichier témoin et le script portent des noms en ASCII : ils figurent dans le texte du script.
  assert.match(NAMES.marker, /^[a-z-]+\.txt$/);
  assert.match(NAMES.script, /^[A-Za-z]+\.cmd$/);
  // « Conserver les deux » : le nom que l'application donne à la copie.
  assert.equal(NAMES.kept, 'Lettre à Zoé - Copie.txt');
});
