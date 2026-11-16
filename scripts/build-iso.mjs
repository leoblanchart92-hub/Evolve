#!/usr/bin/env node
/**
 * Evolve — Fabrication d'une image disque (.iso) des fichiers distribués.
 *
 * L'image produite est un disque ISO 9660 avec noms longs (Joliet) : Windows,
 * macOS et Linux la montent sans aucun logiciel tiers, et elle se grave telle
 * quelle. Elle est écrite ici même, en Node, sans `mkisofs` ni autre outil :
 * la compilation automatique n'a donc rien à installer.
 *
 * Utilisation :
 *   node scripts/build-iso.mjs [--out=FICHIER.iso] [--label=NOM] [SOURCE[=CIBLE] …]
 *
 *   --out=FICHIER   image produite (par défaut dist/Evolve-<version>.iso)
 *   --label=NOM     nom du volume, 32 caractères au plus (par défaut EVOLVE)
 *   SOURCE          fichier ou dossier à placer dans l'image ; « SOURCE=CIBLE »
 *                   choisit son emplacement et son nom dans l'image
 *
 * Sans argument : les exécutables, le fichier d'empreintes et les documents du
 * projet, tels qu'ils sont publiés.
 *
 * L'image est relue entièrement avant d'être annoncée : descripteurs, dossiers
 * et empreinte de chaque fichier sont comparés au plan (verifyIso).
 *
 * Structure de l'image (norme ECMA-119) :
 *   16 secteurs de zone système · descripteur de volume principal ·
 *   descripteur Joliet · descripteur de fin · tables de chemin · dossiers ·
 *   fichiers. Chaque dossier et chaque fichier commence sur un secteur.
 */

import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync, writeSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Taille d'un secteur, en octets. */
export const SECTOR = 2048;
/** Secteurs réservés avant le premier descripteur de volume. */
export const SYSTEM_SECTORS = 16;
/** Descripteurs écrits : principal, Joliet, fin de série. */
export const DESCRIPTOR_SECTORS = 3;
/** Longueur maximale d'un nom Joliet, en caractères. */
export const JOLIET_NAME_MAX = 64;
/** Taille du tampon de lecture des fichiers. */
const COPY_CHUNK = 1024 * 1024;

// --- Noms -------------------------------------------------------------------------

/**
 * Nom ISO 9660 de base : majuscules, 8.3, suivi de « ;1 ».
 * @param {string} name
 * @returns {string}
 */
export function isoBasicName(name) {
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const extension = dot > 0 ? name.slice(dot + 1).toUpperCase().replace(/[^A-Z0-9_]/g, '_') : '';
  return `${(stem || '_').slice(0, 8)}${extension ? `.${extension.slice(0, 3)}` : ''};1`;
}

/** Nom Joliet : le nom complet, raccourci s'il dépasse 64 caractères. */
export function jolietName(name) {
  if (name.length <= JOLIET_NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem.slice(0, JOLIET_NAME_MAX - extension.length)}${extension}`;
}

/** Rend un nom unique dans un dossier (deux fichiers ne portent pas le même). */
function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; index < 10000; index += 1) {
    const suffix = `~${index}`;
    const candidate = `${stem.slice(0, Math.max(1, JOLIET_NAME_MAX - suffix.length - extension.length))}${suffix}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Trop de noms semblables : ${name}`);
}

// --- Arborescence ------------------------------------------------------------------

/** Crée un dossier. */
function makeDir(name) {
  return { name, type: 'dir', children: [], entries: [] };
}

/** Ajoute un fichier (`source`) à l'emplacement `parts` de l'arborescence. */
function addFile(dir, parts, source) {
  if (parts.length === 1) {
    dir.entries.push({ source, name: parts[0] });
    return;
  }
  const [head, ...rest] = parts;
  let child = dir.children.find((item) => item.name === head);
  if (!child) {
    child = makeDir(head);
    dir.children.push(child);
  }
  addFile(child, rest, source);
}

/** Trie : dossiers d'abord, puis fichiers, chacun par nom. */
function sortTree(dir) {
  dir.children.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  dir.entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const child of dir.children) sortTree(child);
}

/**
 * Numérote les dossiers (racine = 1) — un dossier porte toujours un numéro
 * plus petit que ses enfants, comme l'exige la norme — et attribue à chacun un
 * nom de base et un nom Joliet uniques dans son dossier parent.
 */
function numberDirs(tree) {
  const dirs = [];
  const queue = [tree];
  while (queue.length) {
    const dir = queue.shift();
    dir.number = dirs.length + 1;
    dir.parent = dir.parentNumber ?? 1;
    dirs.push(dir);
    for (const child of dir.children) {
      child.parentNumber = dir.number;
      queue.push(child);
    }
  }
  // La racine se désigne elle-même : son entrée de table de chemin est vide.
  dirs[0].isoName = '';
  dirs[0].jolietName = '';
  for (const dir of dirs) {
    const siblings = dirs.filter((other) => other.parent === dir.number && other !== dir);
    const takenBasic = new Set();
    const takenLong = new Set();
    for (const child of siblings) {
      child.isoName = uniqueName(isoBasicName(child.name).replace(/;1$/, ''), takenBasic);
      child.jolietName = uniqueName(jolietName(child.name), takenLong);
      takenBasic.add(child.isoName);
      takenLong.add(child.jolietName);
    }
    const fileBasic = new Set(siblings.map((child) => child.isoName));
    const fileLong = new Set(siblings.map((child) => child.jolietName));
    for (const entry of dir.entries) {
      entry.isoName = uniqueName(isoBasicName(entry.name), fileBasic);
      entry.jolietName = uniqueName(jolietName(entry.name), fileLong);
      fileBasic.add(entry.isoName);
      fileLong.add(entry.jolietName);
    }
  }
  return dirs;
}

// --- Enregistrements ---------------------------------------------------------------

/** Horodatage d'un enregistrement (7 octets). */
function recordDate(date) {
  const bytes = Buffer.alloc(7);
  bytes[0] = date.getUTCFullYear() - 1900;
  bytes[1] = date.getUTCMonth() + 1;
  bytes[2] = date.getUTCDate();
  bytes[3] = date.getUTCHours();
  bytes[4] = date.getUTCMinutes();
  bytes[5] = date.getUTCSeconds();
  bytes[6] = 0;
  return bytes;
}

/** Horodatage d'un descripteur de volume (17 caractères « AAAAMMJJHHMMSScc » + fuseau). */
function descriptorDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const text =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}00`;
  return Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from([0])]);
}

/** Écrit un entier 32 bits en « double endian » (petit bout puis gros bout). */
function bothEndian(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}

/** Écrit un entier 16 bits en « double endian ». */
function bothEndian16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}

/** Entrée « . » d'un dossier (un octet nul, comme le veut la norme). */
const DOT = '\u0000';
/** Entrée « .. » d'un dossier (octet 0x01). */
const DOT_DOT = '\u0001';

/** Encode un identifiant : latin1 pour l'ISO de base, UCS-2 gros bout pour Joliet. */
function identifier(text, unicode) {
  const bytes = Buffer.from(text, unicode ? 'utf16le' : 'latin1');
  if (unicode) bytes.swap16();
  return bytes;
}

/**
 * Identifiant d'un enregistrement. « . » et « .. » sont des octets uniques,
 * y compris en Joliet (ils ne sont pas traduits en UCS-2).
 */
function recordIdentifier({ iso, joliet }, unicode) {
  const text = unicode ? joliet : iso;
  return text === DOT || text === DOT_DOT ? Buffer.from(text, 'latin1') : identifier(text, unicode);
}

/** Enregistrement d'un dossier ou d'un fichier (§ 9.1 de la norme). */
function directoryRecord({ lba, size, type, date }, { iso, joliet }, unicode) {
  const name = recordIdentifier({ iso, joliet }, unicode);
  const length = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
  const record = Buffer.alloc(length);
  record[0] = length;
  record[1] = 0; // aucun attribut étendu
  bothEndian(record, 2, lba);
  bothEndian(record, 10, size);
  recordDate(date).copy(record, 18);
  record[25] = type === 'dir' ? 0x02 : 0x00;
  record[26] = 0; // taille d'unité
  record[27] = 0; // entrelacement
  bothEndian16(record, 28, 1); // numéro de volume
  record[32] = name.length;
  name.copy(record, 33);
  return record;
}

/** Table de chemin : une entrée par dossier (§ 9.4 de la norme). */
function pathTable(dirs, { unicode, bigEndian, field = 'isoLba' }) {
  const entries = dirs.map((dir) => {
    const name = identifier(unicode ? dir.jolietName : dir.isoName, unicode);
    const entry = Buffer.alloc(8 + name.length + (name.length % 2));
    entry[0] = name.length;
    entry[1] = 0;
    if (bigEndian) entry.writeUInt32BE(dir[field], 2);
    else entry.writeUInt32LE(dir[field], 2);
    if (bigEndian) entry.writeUInt16BE(dir.parent, 6);
    else entry.writeUInt16LE(dir.parent, 6);
    name.copy(entry, 8);
    return entry;
  });
  const table = Buffer.concat(entries);
  const padded = Buffer.alloc(Math.ceil(table.length / SECTOR) * SECTOR);
  table.copy(padded);
  return { bytes: padded, size: table.length };
}

/**
 * Descripteur de volume. `type` vaut 1 pour le principal (noms de base) et 2
 * pour le supplémentaire (Joliet) ; les deux décrivent les mêmes fichiers.
 */
function volumeDescriptor({ type, volume, space, date, rootRecord, pathTables }) {
  const sector = Buffer.alloc(SECTOR);
  sector[0] = type;
  Buffer.from('CD001', 'latin1').copy(sector, 1);
  sector[6] = 1; // version du descripteur
  const unicode = type === 2;
  /** Écrit un champ de texte (UCS-2 pour Joliet, latin1 sinon). */
  const text = (value, offset, length) => {
    const bytes = identifier(String(value).slice(0, unicode ? length / 2 : length), unicode);
    bytes.copy(sector, offset);
  };
  text('', 8, 32); // système
  text(volume, 40, 32); // nom du volume
  if (unicode) Buffer.from('%/@', 'latin1').copy(sector, 88); // séquence d'échappement
  bothEndian(sector, 80, space); // taille du volume, en secteurs
  bothEndian16(sector, 120, 1); // ensemble de volumes
  bothEndian16(sector, 124, 1); // numéro de volume
  bothEndian16(sector, 128, SECTOR); // taille d'un secteur
  bothEndian(sector, 132, pathTables.size); // taille de la table de chemin
  sector.writeUInt32LE(pathTables.little, 140); // table en petit bout
  sector.writeUInt32LE(0, 144); // table facultative : aucune
  sector.writeUInt32BE(pathTables.big, 148); // table en gros bout
  sector.writeUInt32BE(0, 152);
  rootRecord.copy(sector, 156); // enregistrement de la racine
  text('', 190, 128); // ensemble de volumes
  text('Evolve', 318, 128); // éditeur
  text('Evolve', 446, 128); // préparateur des données
  text(`Evolve ${pkg.version}`, 574, 128); // application
  text('', 702, 37); // fichier de copyright
  text('', 739, 37); // résumé
  text('', 776, 37); // référence bibliographique
  const stamp = descriptorDate(date);
  for (const offset of [813, 830, 847, 864]) stamp.copy(sector, offset);
  sector[881] = 1; // version de la structure de fichiers
  return sector;
}

/** Taille, en octets, d'une table de chemin (avant attribution des secteurs). */
function pathTableSize(dirs, unicode) {
  return dirs.reduce((total, dir) => {
    const name = identifier(unicode ? dir.jolietName : dir.isoName, unicode);
    return total + 8 + name.length + (name.length % 2);
  }, 0);
}

/** Descripteur de fin de série. */
function terminatorDescriptor() {
  const sector = Buffer.alloc(SECTOR);
  sector[0] = 255;
  Buffer.from('CD001', 'latin1').copy(sector, 1);
  sector[6] = 1;
  return sector;
}

// --- Plan de l'image --------------------------------------------------------------

/** Construit l'arborescence, numérote les dossiers et réserve les secteurs. */
export function planIso(files, { date = new Date() } = {}) {
  const tree = makeDir('');
  for (const file of files) addFile(tree, file.target.split('/').filter(Boolean), file.source);
  sortTree(tree);
  const dirs = numberDirs(tree);

  for (const dir of dirs) {
    dir.date = date;
    for (const entry of dir.entries) {
      entry.size = statSync(entry.source).size;
      entry.type = 'file';
      entry.date = date;
    }
  }

  /**
   * Enregistrements d'un dossier, dans l'un des deux jeux de noms.
   * L'ISO de base et Joliet forment deux arborescences distinctes : chacune a
   * ses propres dossiers (donc ses propres secteurs) et désigne les mêmes
   * fichiers.
   */
  const recordsOf = (dir, unicode, lbaOf, sizeOf) => {
    const records = [];
    const parentDir = dirs[dir.parent - 1];
    records.push(
      directoryRecord({ lba: lbaOf(dir), size: sizeOf(dir), type: 'dir', date }, { iso: DOT, joliet: DOT }, unicode),
    );
    records.push(
      directoryRecord(
        { lba: lbaOf(parentDir), size: sizeOf(parentDir), type: 'dir', date },
        { iso: DOT_DOT, joliet: DOT_DOT },
        unicode,
      ),
    );
    for (const child of dir.children) {
      records.push(
        directoryRecord(
          { lba: lbaOf(child), size: sizeOf(child), type: 'dir', date },
          { iso: child.isoName, joliet: child.jolietName },
          unicode,
        ),
      );
    }
    for (const entry of dir.entries) {
      records.push(
        directoryRecord(
          { lba: entry.lba ?? 0, size: entry.size, type: 'file', date },
          { iso: entry.isoName, joliet: entry.jolietName },
          unicode,
        ),
      );
    }
    return records;
  };

  /** Secteurs occupés par un jeu d'enregistrements. */
  const sectorsFor = (records) => Math.ceil(records.reduce((total, record) => total + record.length, 0) / SECTOR);

  // Les tables de chemin précèdent les dossiers ; leur taille est connue d'avance.
  const isoSectorsTable = Math.ceil(pathTableSize(dirs, false) / SECTOR);
  const jolietSectorsTable = Math.ceil(pathTableSize(dirs, true) / SECTOR);
  const pathSectors = 2 * isoSectorsTable + 2 * jolietSectorsTable;
  const pathStart = SYSTEM_SECTORS + DESCRIPTOR_SECTORS;

  // Dossiers de l'ISO de base, puis ceux de Joliet : la racine d'abord.
  let cursor = pathStart + pathSectors;
  for (const dir of dirs) {
    const records = recordsOf(dir, false, (item) => item.isoLba ?? 0, (item) => item.isoSize ?? 0);
    dir.isoLba = cursor;
    dir.isoSize = records.reduce((total, record) => total + record.length, 0);
    cursor += sectorsFor(records);
  }
  for (const dir of dirs) {
    const records = recordsOf(dir, true, (item) => item.jolietLba ?? 0, (item) => item.jolietSize ?? 0);
    dir.jolietLba = cursor;
    dir.jolietSize = records.reduce((total, record) => total + record.length, 0);
    cursor += sectorsFor(records);
  }

  // Fichiers : un seul exemplaire, désigné par les deux arborescences.
  const blobs = [];
  for (const dir of dirs) {
    for (const entry of dir.entries) {
      entry.lba = cursor;
      blobs.push(entry);
      cursor += Math.ceil(entry.size / SECTOR);
    }
  }

  // Les enregistrements sont définitifs une fois tous les emplacements connus.
  for (const dir of dirs) {
    dir.isoRecords = recordsOf(dir, false, (item) => item.isoLba, (item) => item.isoSize);
    dir.jolietRecords = recordsOf(dir, true, (item) => item.jolietLba, (item) => item.jolietSize);
  }

  return {
    dirs,
    blobs,
    space: cursor,
    date,
    paths: {
      start: pathStart,
      sectors: pathSectors,
      // Chaque descripteur désigne ses propres tables : l'ISO de base et
      // Joliet n'ont pas les mêmes noms, donc pas les mêmes tables.
      iso: { size: pathTableSize(dirs, false), little: pathStart, big: pathStart + isoSectorsTable },
      joliet: {
        size: pathTableSize(dirs, true),
        little: pathStart + 2 * isoSectorsTable,
        big: pathStart + 2 * isoSectorsTable + jolietSectorsTable,
      },
      isoLittle: pathTable(dirs, { unicode: false, bigEndian: false, field: 'isoLba' }),
      isoBig: pathTable(dirs, { unicode: false, bigEndian: true, field: 'isoLba' }),
      jolietLittle: pathTable(dirs, { unicode: true, bigEndian: false, field: 'jolietLba' }),
      jolietBig: pathTable(dirs, { unicode: true, bigEndian: true, field: 'jolietLba' }),
    },
  };
}

/**
 * Empreinte SHA-256 d'un fichier, lu par morceaux (les fichiers sont gros).
 * @param {string} file
 */
export function sha256File(file) {
  const hash = createHash('sha256');
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

/**
 * Relit l'image produite et la confronte au plan : descripteurs en place,
 * dossiers lisibles dans les deux jeux de noms, et chaque fichier retrouvé à
 * l'identique à l'emplacement que désignent les enregistrements. Une image
 * n'est annoncée comme fabriquée qu'après cette relecture.
 *
 * @param {string} file   image à relire
 * @param {object} plan   plan renvoyé par planIso
 * @param {string} label  nom de volume attendu
 * @returns {{ files: number }} nombre de fichiers vérifiés
 */
export function verifyIso(file, plan, label) {
  const stats = statSync(file);
  if (stats.size < plan.space * SECTOR) throw new Error(`Image trop courte : ${stats.size} octets pour ${plan.space} secteurs.`);
  if (stats.size % SECTOR !== 0) throw new Error(`Image non alignée sur les secteurs : ${stats.size} octets.`);

  const handle = openSync(file, 'r');
  /** @param {number} lba @param {number} [length] */
  const readAt = (lba, length = SECTOR) => {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      offset += readSync(handle, buffer, offset, length - offset, lba * SECTOR + offset);
    }
    return buffer;
  };
  /** Empreinte d'une plage de l'image. */
  const hashAt = (lba, size) => {
    const hash = createHash('sha256');
    let remaining = size;
    let cursor = lba * SECTOR;
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    while (remaining > 0) {
      const read = readSync(handle, buffer, 0, Math.min(buffer.length, remaining), cursor);
      if (!read) throw new Error('Lecture interrompue dans l’image.');
      hash.update(buffer.subarray(0, read));
      cursor += read;
      remaining -= read;
    }
    return hash.digest('hex');
  };

  try {
    // Descripteur principal, puis descripteur Joliet (norme ECMA-119).
    const primary = readAt(SYSTEM_SECTORS);
    if (primary[0] !== 1 || primary.subarray(1, 6).toString('latin1') !== 'CD001') throw new Error('Descripteur de volume principal illisible.');
    // Le nom occupe 32 octets : complété par des espaces ou des octets nuls.
    const found = primary.subarray(40, 72).toString('latin1').replace(/[\s\0]+$/, '');
    if (found !== label) throw new Error(`Nom de volume inattendu dans l’image : « ${found} ». attendu « ${label} »`);
    const supplementary = readAt(SYSTEM_SECTORS + 1);
    if (supplementary[0] !== 2 || supplementary.subarray(1, 6).toString('latin1') !== 'CD001') throw new Error('Descripteur Joliet illisible.');
    const escape = supplementary.subarray(88, 91).toString('latin1');
    if (escape !== '%/@' && escape !== '%/C' && escape !== '%/E') throw new Error('Descripteur Joliet : séquence d’échappement absente.');

    // Chaque dossier commence par l'enregistrement « . », qui le désigne
    // lui-même, puis « .. », qui désigne son parent : c'est ce qui permet à
    // Windows, macOS et Linux de parcourir l'arborescence. Les deux jeux de
    // noms sont vérifiés — dans les deux, ces enregistrements tiennent en un
    // seul octet (0x00 puis 0x01), comme le demande la norme.
    for (const dir of plan.dirs) {
      for (const lba of [dir.isoLba, dir.jolietLba]) {
        const first = readAt(lba, SECTOR);
        const itself = first.readUInt32LE(2);
        if (first[32] !== 1 || first[33] !== 0) throw new Error(`Dossier « ${dir.name || '/'} » : enregistrement « . » illisible.`);
        if (itself !== lba) throw new Error(`Dossier « ${dir.name || '/'} » : enregistrement « . » qui ne le désigne pas lui-même.`);
        const second = first.subarray(first[0]);
        if (second[32] !== 1 || second[33] !== 1) throw new Error(`Dossier « ${dir.name || '/'} » : enregistrement « .. » illisible.`);
      }
    }

    // Un seul exemplaire de chaque fichier, désigné par les deux arborescences :
    // l'empreinte relue dans l'image doit être celle du fichier d'origine.
    for (const blob of plan.blobs) {
      if (blob.lba * SECTOR + blob.size > stats.size) throw new Error(`Fichier « ${blob.name} » hors de l’image.`);
      if (hashAt(blob.lba, blob.size) !== sha256File(blob.source)) throw new Error(`Fichier « ${blob.name} » différent dans l’image.`);
    }
    return { files: plan.blobs.length };
  } finally {
    closeSync(handle);
  }
}

// --- Écriture -------------------------------------------------------------------------

/** Écrit dans un fichier secteur par secteur, en complétant le dernier. */
class SectorWriter {
  /** @param {number} handle */
  constructor(handle) {
    this.handle = handle;
    this.cursor = 0;
    this.pending = Buffer.alloc(0);
  }

  /** Secteur courant (prochain secteur écrit). */
  get sector() {
    return this.cursor;
  }

  /** Ajoute des octets ; seuls les secteurs complets sont écrits. */
  write(bytes) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    const full = Math.floor(this.pending.length / SECTOR) * SECTOR;
    if (full === 0) return;
    this.#flush(this.pending.subarray(0, full));
    this.pending = this.pending.subarray(full);
  }

  /** Termine sur une frontière de secteur. */
  close() {
    if (this.pending.length) {
      const last = Buffer.alloc(SECTOR);
      this.pending.copy(last);
      this.#flush(last);
      this.pending = Buffer.alloc(0);
    }
  }

  /** @param {Buffer} bytes  un nombre entier de secteurs */
  #flush(bytes) {
    if (bytes.length % SECTOR !== 0) throw new Error('Bloc non aligné sur un secteur.');
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(this.handle, bytes, offset, bytes.length - offset, this.cursor * SECTOR + offset);
    }
    this.cursor += bytes.length / SECTOR;
  }
}

/**
 * Produit l'image disque.
 * @param {object} options
 * @param {{ source: string, target: string }[]} options.files
 * @param {string} options.out
 * @param {string} [options.volume]  nom du volume (32 caractères au plus)
 * @param {Date} [options.date]
 * @returns {Promise<{ file: string, size: number, files: number, sectors: number, sha256: string }>}
 */
export async function buildIso({ files, out, volume = 'EVOLVE', date = new Date() }) {
  if (!files?.length) throw new Error('Aucun fichier à mettre dans l’image.');
  const plan = planIso(files, { date });
  const label = String(volume).toUpperCase().replace(/[^A-Z0-9_ ]/g, '').slice(0, 32).trim() || 'EVOLVE';

  await mkdir(path.dirname(out), { recursive: true });
  const handle = openSync(out, 'w');
  const writer = new SectorWriter(handle);
  const hash = createHash('sha256');

  try {
    writer.write(Buffer.alloc(SYSTEM_SECTORS * SECTOR));

    const root = plan.dirs[0];
    writer.write(
      volumeDescriptor({
        type: 1,
        volume: label,
        space: plan.space,
        date,
        rootRecord: directoryRecord({ lba: root.isoLba, size: root.isoSize, type: 'dir', date }, { iso: '', joliet: '' }, false),
        pathTables: plan.paths.iso,
      }),
    );
    writer.write(
      volumeDescriptor({
        type: 2,
        volume: label,
        space: plan.space,
        date,
        rootRecord: directoryRecord({ lba: root.jolietLba, size: root.jolietSize, type: 'dir', date }, { iso: '', joliet: '' }, true),
        pathTables: plan.paths.joliet,
      }),
    );
    writer.write(terminatorDescriptor());
    if (writer.sector !== plan.paths.start) throw new Error('Descripteurs de volume mal placés.');

    writer.write(plan.paths.isoLittle.bytes);
    writer.write(plan.paths.isoBig.bytes);
    writer.write(plan.paths.jolietLittle.bytes);
    writer.write(plan.paths.jolietBig.bytes);
    if (writer.sector !== plan.paths.start + plan.paths.sectors) throw new Error('Tables de chemin mal placées.');

    // Les deux arborescences de dossiers, puis les fichiers qu'elles désignent.
    const trees = [
      plan.dirs.map((dir) => ({ dir, records: dir.isoRecords, lba: dir.isoLba })),
      plan.dirs.map((dir) => ({ dir, records: dir.jolietRecords, lba: dir.jolietLba })),
    ];
    for (const tree of trees) {
      for (const { dir, records, lba } of tree) {
        if (writer.sector !== lba) throw new Error(`Dossier « ${dir.name} » mal placé.`);
        for (const record of records) writer.write(record);
        writer.close();
      }
    }

    for (const blob of plan.blobs) {
      if (writer.sector !== blob.lba) throw new Error(`Fichier « ${blob.name} » mal placé.`);
      let seen = 0;
      await new Promise((resolve, reject) => {
        const stream = createReadStream(blob.source, { highWaterMark: COPY_CHUNK });
        stream.on('data', (chunk) => {
          seen += chunk.length;
          hash.update(chunk);
          writer.write(chunk);
        });
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      if (seen !== blob.size) throw new Error(`Fichier modifié pendant la lecture : ${blob.source}`);
      writer.close();
    }
  } finally {
    closeSync(handle);
  }

  // Rien n'est annoncé sans relecture : l'image est confrontée au plan, puis
  // chaque fichier y est relu et comparé à son original.
  const verified = verifyIso(out, plan, label);
  const stats = statSync(out);
  return { file: out, size: stats.size, files: verified.files, sectors: plan.space, sha256: hash.digest('hex') };
}

// --- Ligne de commande ----------------------------------------------------------------

/** Fichiers publiés, tels qu'ils doivent apparaître dans l'image. */
export function defaultFiles() {
  const wanted = [
    { source: path.join(root, 'dist', `Evolve-${pkg.version}-portable.exe`), target: `Evolve-${pkg.version}-portable.exe` },
    { source: path.join(root, 'dist', `Evolve-${pkg.version}-setup.exe`), target: `Evolve-${pkg.version}-setup.exe` },
    { source: path.join(root, 'dist', `Evolve-${pkg.version}-setup-tous-utilisateurs.exe`), target: `Evolve-${pkg.version}-setup-tous-utilisateurs.exe` },
    { source: path.join(root, 'dist', 'SHA256SUMS.txt'), target: 'SHA256SUMS.txt' },
    { source: path.join(root, 'README.md'), target: 'LISEZ-MOI.md' },
    { source: path.join(root, 'THIRD-PARTY-NOTICES.md'), target: 'documents/licences-tiers.md' },
  ];
  return wanted.filter((file) => {
    try {
      return statSync(file.source).isFile();
    } catch {
      console.warn(`! ${path.relative(root, file.source)} : absent, non inclus dans l’image`);
      return false;
    }
  });
}

/** Rassemble récursivement les fichiers d'un dossier. */
async function collectDir(dir, target, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const source = path.join(dir, entry.name);
    const destination = target ? `${target}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectDir(source, destination, found);
    else if (entry.isFile()) found.push({ source, target: destination });
  }
  return found;
}

export async function main(argv) {
  const outOption = argv.find((arg) => arg.startsWith('--out='));
  const labelOption = argv.find((arg) => arg.startsWith('--label='));
  const positional = argv.filter((arg) => !arg.startsWith('--'));

  let files = [];
  if (positional.length) {
    for (const argument of positional) {
      const separator = argument.indexOf('=');
      const source = path.resolve(separator < 0 ? argument : argument.slice(0, separator));
      const target = separator < 0 ? path.basename(source) : argument.slice(separator + 1);
      if (statSync(source).isDirectory()) files = await collectDir(source, target, files);
      else files.push({ source, target });
    }
  } else {
    files = defaultFiles();
  }

  const out = path.resolve(outOption ? outOption.slice('--out='.length) : path.join(root, 'dist', `Evolve-${pkg.version}.iso`));
  const result = await buildIso({ files, out, volume: labelOption ? labelOption.slice('--label='.length) : 'EVOLVE' });
  console.log(
    `✔ ${path.relative(root, result.file)} : ${(result.size / 1024 / 1024).toFixed(1)} Mo, ${result.files} fichier(s)\n  SHA-256 ${result.sha256}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error) => {
      console.error(`✖ ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}
