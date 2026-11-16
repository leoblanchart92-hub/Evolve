/**
 * Empreintes des fichiers publiés (scripts/checksums.mjs). Le service des
 * mises à jour lit ce fichier pour vérifier qu'un fichier téléchargé est bien
 * celui qui a été publié : son format doit donc être celui de `sha256sum`,
 * et il doit couvrir les quatre fichiers distribués.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { readText } from './helpers.mjs';
import { checksumLine, defaultFiles, main, parseChecksums, sha256File } from '../scripts/checksums.mjs';

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-checksums-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const pkg = JSON.parse(readText('package.json'));

/** Crée un fichier et renvoie son chemin. */
function file(name, content = `contenu de ${name}\n`) {
  const target = path.join(workDir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

/** Empreinte d'un contenu, calculée ici — jamais par le script testé. */
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

test('sha256File : l’empreinte d’un fichier, même volumineux', async () => {
  const small = file('petit.txt', 'Evolve\n');
  assert.equal(await sha256File(small), sha256('Evolve\n'));
  assert.match(await sha256File(small), /^[0-9a-f]{64}$/);
  // Lu par morceaux : un fichier plus gros que le tampon donne la même empreinte.
  const big = file('gros.bin', Buffer.alloc(3 * 1024 * 1024, 0x5a));
  assert.equal(await sha256File(big), sha256(readFileSync(big)));
});

test('checksumLine : deux espaces entre l’empreinte et le nom, comme sha256sum', () => {
  const hash = 'a'.repeat(64);
  assert.equal(checksumLine(hash, 'Evolve-0.4.0.iso'), `${hash}  Evolve-0.4.0.iso`);
  assert.match(checksumLine(hash, 'x'), /^[0-9a-f]{64} {2}\S/);
});

test('parseChecksums : le nom seul est retenu, les lignes inutilisables ignorées', () => {
  const first = 'a'.repeat(64);
  const second = 'B'.repeat(64);
  const text = [
    `${first}  Evolve-0.4.0-portable.exe`,
    `${second} *dist/Evolve-0.4.0.iso`,
    '',
    '   ',
    'ligne sans empreinte',
    '1234  trop court',
    `${second.toUpperCase()}  doublon.exe`,
  ].join('\r\n');
  const found = parseChecksums(text);
  assert.deepEqual([...found.keys()], ['Evolve-0.4.0-portable.exe', 'Evolve-0.4.0.iso', 'doublon.exe']);
  // Les fins de ligne Windows sont acceptées, et l'empreinte est en minuscules.
  assert.equal(found.get('Evolve-0.4.0.iso'), second.toLowerCase());
  // Un nom de dossier est ramené au nom du fichier, comme le fait sha256sum -c.
  assert.equal(parseChecksums(`${first}  dist/sous-dossier/Evolve.exe`).get('Evolve.exe'), first);
  assert.deepEqual([...parseChecksums('').keys()], []);
  assert.deepEqual([...parseChecksums(null).keys()], []);
});

test('defaultFiles : les trois exécutables et l’image .iso de la version en cours', () => {
  const names = defaultFiles().map((name) => path.basename(name));
  assert.deepEqual(names, [
    `Evolve-${pkg.version}-portable.exe`,
    `Evolve-${pkg.version}-setup.exe`,
    `Evolve-${pkg.version}-setup-tous-utilisateurs.exe`,
    `Evolve-${pkg.version}.iso`,
  ]);
  for (const name of defaultFiles()) assert.ok(name.startsWith(path.join(path.resolve('.'), 'dist') + path.sep), name);
});

test('main : un fichier d’empreintes, une ligne par fichier publié', async () => {
  const out = path.join(workDir, 'SHA256SUMS.txt');
  const first = file('Evolve-0.4.0-portable.exe');
  const second = file('Evolve-0.4.0.iso');
  assert.equal(await main([first, second, `--out=${out}`]), 0);
  assert.deepEqual(readFileSync(out, 'utf8').split('\n').filter(Boolean), [
    `${await sha256File(first)}  Evolve-0.4.0-portable.exe`,
    `${await sha256File(second)}  Evolve-0.4.0.iso`,
  ]);
  // Ce que le service des mises à jour relit : les deux fichiers, par leur nom.
  const found = parseChecksums(readFileSync(out, 'utf8'));
  assert.deepEqual([...found.keys()], ['Evolve-0.4.0-portable.exe', 'Evolve-0.4.0.iso']);
  assert.equal(found.get('Evolve-0.4.0.iso'), await sha256File(second));
});

test('main : un fichier explicitement demandé mais absent est signalé, sans interrompre le reste', async () => {
  const out = path.join(workDir, 'partiel.txt');
  const present = file('present.exe', 'là\n');
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(await main([present, path.join(workDir, 'absent.exe'), `--out=${out}`]), 0);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /absent\.exe : ignoré/);
  assert.equal(readFileSync(out, 'utf8'), `${await sha256File(present)}  present.exe\n`);
});

test('main : sans aucun fichier mesurable, la commande échoue', async () => {
  const warnings = [];
  const errors = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (message) => warnings.push(message);
  console.error = (message) => errors.push(message);
  try {
    assert.equal(await main([path.join(workDir, 'introuvable.exe'), `--out=${path.join(workDir, 'rien.txt')}`]), 1);
  } finally {
    console.warn = warn;
    console.error = error;
  }
  assert.match(errors.join('\n'), /aucun fichier à mesurer/);
  // Sans argument, les fichiers publiés manquants sont laissés de côté en
  // silence : dist/ est vide tant que la compilation n'a rien fabriqué.
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(await main([]), 1);
  } finally {
    console.warn = warn;
  }
});
