/**
 * Fabrication de l'image disque (scripts/build-iso.mjs). L'image doit être un
 * disque ISO 9660 avec noms longs Joliet, que Windows, macOS et Linux montent
 * sans logiciel tiers ; elle est relue entièrement avant d'être annoncée, et
 * chaque fichier doit y être retrouvé à l'identique.
 *
 * Ces essais écrivent de petites images dans un dossier temporaire : rien n'est
 * produit dans dist/.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { fromRoot, readText } from './helpers.mjs';
import {
  buildIso,
  defaultFiles,
  DESCRIPTOR_SECTORS,
  isoBasicName,
  jolietName,
  JOLIET_NAME_MAX,
  main,
  planIso,
  SECTOR,
  sha256File,
  SYSTEM_SECTORS,
  verifyIso,
} from '../scripts/build-iso.mjs';

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-build-iso-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Date figée : une image fabriquée deux fois avec les mêmes fichiers est identique. */
const DATE = new Date('2026-11-16T10:00:00Z');

/** Empreinte SHA-256 d'un contenu, calculée ici — jamais par le script testé. */
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

let sequence = 0;

/**
 * Crée un dossier de fichiers à mettre dans l'image.
 * @param {Record<string, string>} files  emplacement dans l'image → contenu
 * @returns {{ source: string, target: string }[]}
 */
function sources(files) {
  const dir = path.join(workDir, `jeu-${(sequence += 1)}`);
  mkdirSync(dir, { recursive: true });
  const list = [];
  for (const [target, content] of Object.entries(files)) {
    const source = path.join(dir, target.replaceAll('/', '__'));
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, content);
    list.push({ source, target });
  }
  return list;
}

/** Petit jeu de fichiers : vide, accentué, imbriqué, et un nom très long. */
function sample() {
  return sources({
    'LISEZ-MOI.md': 'document\n',
    'racine.txt': 'contenu de la racine\n',
    'vide.txt': '',
    'nom avec accents éà.txt': 'accents\n',
    [`documents/${'a'.repeat(80)}.txt`]: 'nom long\n',
    'documents/rapport.pdf': '%PDF-1.7 faux\n',
    'documents/sous-dossier/notes.txt': 'notes imbriquées\n',
  });
}

test('noms : ISO de base en 8.3 majuscules, Joliet jusqu’à 64 caractères', () => {
  assert.equal(isoBasicName('Evolve-0.4.0-portable.exe'), 'EVOLVE_0.EXE;1');
  assert.equal(isoBasicName('LISEZ-MOI.md'), 'LISEZ_MO.MD;1');
  assert.equal(isoBasicName('sans-extension'), 'SANS_EXT;1');
  assert.equal(isoBasicName('nom avec accents éà.txt'), 'NOM_AVEC.TXT;1');
  assert.equal(jolietName('Evolve-0.4.0-setup-tous-utilisateurs.exe'), 'Evolve-0.4.0-setup-tous-utilisateurs.exe');
  assert.equal(jolietName('nom avec accents éà.txt'), 'nom avec accents éà.txt');
  // Un nom trop long est raccourci, mais son extension est conservée.
  const long = jolietName(`${'a'.repeat(80)}.txt`);
  assert.equal(long.length, JOLIET_NAME_MAX);
  assert.match(long, /\.txt$/);
});

test('plan : un seul exemplaire de chaque fichier, deux arborescences de dossiers', () => {
  const files = sample();
  const plan = planIso(files, { date: DATE });

  // Les fichiers se suivent, sans se chevaucher, après tous les dossiers.
  const lastDir = Math.max(...plan.dirs.map((dir) => dir.jolietLba));
  let cursor = lastDir;
  for (const blob of plan.blobs) {
    assert.ok(blob.lba >= cursor, `chevauchement pour ${blob.name}`);
    cursor = blob.lba + Math.ceil(blob.size / SECTOR);
  }
  assert.equal(plan.space, cursor);
  assert.equal(plan.blobs.length, files.length);

  // Chaque dossier existe deux fois : une entrée ISO de base, une entrée Joliet.
  for (const dir of plan.dirs) {
    assert.ok(dir.isoLba < dir.jolietLba, dir.name);
    assert.ok(dir.isoSize > 0 && dir.jolietSize > 0, dir.name);
  }
  // Les tables de chemin sont complètes dans les deux jeux de noms.
  assert.equal(plan.paths.start, SYSTEM_SECTORS + DESCRIPTOR_SECTORS);
  assert.ok(plan.paths.iso.size > 0 && plan.paths.joliet.size > 0);
  assert.ok(plan.paths.joliet.size > plan.paths.iso.size, 'les noms longs tiennent plus de place');
  assert.equal(plan.paths.sectors % 2, 0, 'un nombre entier de secteurs par jeu');
  // Un fichier vide ne consomme aucun secteur, mais garde sa place dans l'ordre.
  const empty = plan.blobs.find((blob) => blob.name === 'vide.txt');
  assert.equal(empty.size, 0);
});

test('image : descripteurs en place, puis chaque fichier retrouvé à l’identique', async () => {
  const files = sample();
  const out = path.join(workDir, 'image.iso');
  const result = await buildIso({ files, out, volume: 'Evolve 0.4.0', date: DATE });

  assert.equal(result.files, files.length);
  assert.equal(result.size % SECTOR, 0);
  assert.equal(result.size, result.sectors * SECTOR);

  // Relue telle quelle : chaque fichier est là où les enregistrements le disent.
  const plan = planIso(files, { date: DATE });
  const handle = openSync(out, 'r');
  /** @param {number} lba @param {number} length */
  const readAt = (lba, length) => {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) offset += readSync(handle, buffer, offset, length - offset, lba * SECTOR + offset);
    return buffer;
  };
  try {
    for (const blob of plan.blobs) {
      assert.equal(readAt(blob.lba, blob.size).toString('utf8'), readFileSync(blob.source, 'utf8'), blob.name);
    }
    // Descripteur principal, Joliet, puis fin de série (norme ECMA-119).
    const primary = readAt(SYSTEM_SECTORS, SECTOR);
    assert.equal(primary[0], 1);
    assert.equal(primary.subarray(1, 6).toString('latin1'), 'CD001');
    assert.equal(primary.subarray(40, 72).toString('latin1').replace(/[\s\0]+$/, ''), 'EVOLVE 040');
    const joliet = readAt(SYSTEM_SECTORS + 1, SECTOR);
    assert.equal(joliet[0], 2);
    assert.equal(joliet.subarray(1, 6).toString('latin1'), 'CD001');
    assert.equal(joliet.subarray(88, 91).toString('latin1'), '%/@', 'noms longs (Joliet)');
    assert.equal(readAt(SYSTEM_SECTORS + 2, SECTOR)[0], 255, 'descripteur de fin de série');
  } finally {
    closeSync(handle);
  }
});

test('relecture : un octet changé, une image tronquée ou un autre volume sont refusés', async () => {
  const files = sources({ 'a.txt': 'contenu d’origine\n', 'b/c.txt': 'imbriqué\n' });
  const out = path.join(workDir, 'controle.iso');
  const plan = planIso(files, { date: DATE });
  await buildIso({ files, out, volume: 'EVOLVE', date: DATE });
  assert.deepEqual(verifyIso(out, plan, 'EVOLVE'), { files: 2 });

  // Un octet du premier fichier est changé dans l'image.
  const patched = openSync(out, 'r+');
  writeSync(patched, Buffer.from([0x00]), 0, 1, plan.blobs[0].lba * SECTOR);
  closeSync(patched);
  assert.throws(() => verifyIso(out, plan, 'EVOLVE'), /Fichier « a\.txt » différent dans l’image/);

  // Image tronquée : le dernier secteur manque.
  const truncated = path.join(workDir, 'tronquee.iso');
  writeFileSync(truncated, readFileSync(out).subarray(0, plan.space * SECTOR - SECTOR));
  assert.throws(() => verifyIso(truncated, plan, 'EVOLVE'), /Image trop courte/);

  // Le nom du volume est bien celui qui a été demandé.
  assert.throws(() => verifyIso(out, plan, 'AUTRE'), /Nom de volume inattendu/);
});

test('situations refusées : aucun fichier, source disparue', async () => {
  await assert.rejects(() => buildIso({ files: [], out: path.join(workDir, 'vide.iso') }), /Aucun fichier à mettre dans l’image/);
  await assert.rejects(
    () =>
      buildIso({
        files: [{ source: path.join(workDir, 'introuvable.txt'), target: 'x.txt' }],
        out: path.join(workDir, 'x.iso'),
      }),
    /ENOENT|introuvable/,
  );
});

test('fichiers publiés par défaut : les trois exécutables, les empreintes et la documentation', () => {
  const source = readText('scripts', 'build-iso.mjs');
  // Ce que l'image contient, et sous quel nom (voir README).
  for (const [published, target] of [
    ['-portable.exe', 'Evolve-${pkg.version}-portable.exe'],
    ['-setup.exe', 'Evolve-${pkg.version}-setup.exe'],
    ['-setup-tous-utilisateurs.exe', 'Evolve-${pkg.version}-setup-tous-utilisateurs.exe'],
    ['SHA256SUMS.txt', 'SHA256SUMS.txt'],
    ['README.md', 'LISEZ-MOI.md'],
    ['THIRD-PARTY-NOTICES.md', 'documents/licences-tiers.md'],
  ]) {
    assert.ok(source.includes(target), `fichier absent de la liste : ${published}`);
  }
  // Les exécutables ne sont pas encore fabriqués : ils sont laissés de côté,
  // tandis que la documentation, toujours présente, est retenue.
  const wanted = defaultFiles();
  assert.deepEqual(wanted.map((file) => file.target), ['LISEZ-MOI.md', 'documents/licences-tiers.md']);
  for (const file of wanted) assert.ok(existsSync(file.source), file.source);
});

test('ligne de commande : une image est fabriquée, vérifiée et annoncée', async () => {
  const out = path.join(workDir, 'cli', 'Evolve.iso');
  const files = sample();
  const code = await main([`--out=${out}`, '--label=Evolve 0.4.0', ...files.map((file) => `${file.source}=${file.target}`)]);
  assert.equal(code, 0);
  const stats = statSync(out);
  assert.equal(stats.size % SECTOR, 0);
  assert.ok(stats.size > SYSTEM_SECTORS * SECTOR);
  // Sans --label, le nom du volume est « EVOLVE ».
  const other = path.join(workDir, 'cli', 'autre.iso');
  assert.equal(await main([`--out=${other}`, `${files[0].source}=${files[0].target}`]), 0);
  const handle = openSync(other, 'r');
  const sector = Buffer.alloc(SECTOR);
  readSync(handle, sector, 0, SECTOR, SYSTEM_SECTORS * SECTOR);
  closeSync(handle);
  assert.equal(sector.subarray(40, 72).toString('latin1').replace(/[\s\0]+$/, ''), 'EVOLVE');
});

test('sha256File : l’empreinte d’un fichier, lu par morceaux', () => {
  const file = path.join(workDir, 'empreinte.bin');
  const content = Buffer.concat([Buffer.alloc(3 * 1024 * 1024, 7), Buffer.from('Evolve\n')]);
  writeFileSync(file, content);
  assert.equal(sha256File(file), createHash('sha256').update(content).digest('hex'));
  assert.equal(sha256File(file), sha256(content));
});

test('l’image .iso du projet est annoncée par le README et publiée par la compilation', () => {
  // Le nom du fichier produit correspond à celui que la compilation publie.
  const source = readText('scripts', 'build-iso.mjs');
  assert.match(source, /`Evolve-\$\{pkg\.version\}\.iso`/);
  assert.match(readText('README.md'), /Evolve-0\.4\.0\.iso/);
  assert.ok(existsSync(fromRoot('scripts', 'build-iso.mjs')));
});
