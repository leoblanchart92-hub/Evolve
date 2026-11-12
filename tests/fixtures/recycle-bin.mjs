/**
 * Fausse Corbeille de Windows, pour les tests : un dossier rangé comme
 * « X:\$RECYCLE.BIN », où chaque élément envoyé laisse une fiche « $I… »
 * (emplacement d'origine) et l'élément lui-même, « $R… », dans le dossier
 * du compte.
 */
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Dossier d'un compte dans la Corbeille (son identifiant de sécurité). */
export const ACCOUNT = 'S-1-5-21-1004336348-1177238915-682003330-1001';

/**
 * Fiche « $I… » telle que Windows l'écrit : version, taille de l'élément,
 * date de l'envoi, puis l'emplacement d'origine en UTF-16 — précédé de sa
 * longueur depuis Windows 10 (version 2), sur 260 caractères auparavant (version 1).
 */
export function recycleRecord(original, { version = 2, size = 0 } = {}) {
  const head = Buffer.alloc(24);
  head.writeBigInt64LE(BigInt(version), 0);
  head.writeBigInt64LE(BigInt(size), 8);
  // Date de l'envoi : nombre de centaines de nanosecondes depuis le 1er janvier 1601.
  head.writeBigInt64LE(134_000_000_000_000_000n, 16);
  const text = Buffer.from(`${original}\0`, 'utf16le');
  if (version === 1) {
    const fixed = Buffer.alloc(520);
    text.copy(fixed);
    return Buffer.concat([head, fixed]);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(text.length / 2, 0);
  return Buffer.concat([head, length, text]);
}

let serial = 0;

/**
 * Envoie `location` dans la fausse Corbeille `bin`, comme le fait Windows.
 * @returns {{ record: string, content: string }} la fiche et l'élément
 */
export function recycle(bin, location, { version = 2, account = ACCOUNT } = {}) {
  const owner = path.join(bin, account);
  mkdirSync(owner, { recursive: true });
  serial += 1;
  const id = `${serial.toString(36).toUpperCase().padStart(6, '0')}${path.extname(location)}`;
  const record = path.join(owner, `$I${id}`);
  const content = path.join(owner, `$R${id}`);
  const info = statSync(location);
  writeFileSync(record, recycleRecord(location, { version, size: info.isFile() ? info.size : 0 }));
  renameSync(location, content);
  return { record, content };
}
