/** Façon dont Evolve a été lancé (src/main/variant.js) : seule la version installée se met à jour. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { UNINSTALLER_EXE } from '../scripts/setup-tools.mjs';
import { readText } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { detectVariant, UNINSTALLER } = require('../src/main/variant.js');
const { VARIANTS } = require('../src/services/updates.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-variante-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Dossier contenant un faux programme et, au besoin, le désinstallateur que l'installateur pose à côté. */
function programDir(name, { uninstaller = false } = {}) {
  const dir = path.join(workDir, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'Evolve.exe'), '');
  if (uninstaller) writeFileSync(path.join(dir, UNINSTALLER), '');
  return path.join(dir, 'Evolve.exe');
}

test('version installée : le désinstallateur est à côté du programme', () => {
  const installed = programDir('installe', { uninstaller: true });
  assert.equal(detectVariant({ packaged: true, env: {}, execPath: installed }), 'installed');
  // Le nom du désinstallateur est celui que l'installateur écrit, et que la vérification de l'installation attend.
  assert.equal(UNINSTALLER, 'Uninstall Evolve.exe');
  assert.equal(UNINSTALLER, UNINSTALLER_EXE);
  assert.equal(UNINSTALLER, `Uninstall ${JSON.parse(readText('package.json')).build.productName}.exe`);
});

test('exécutable portable : reconnu à la variable que pose son lanceur, même à côté d’un désinstallateur', () => {
  const installed = programDir('portable-a-cote', { uninstaller: true });
  const env = { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\Léa\\Downloads\\Evolve-0.6.0-portable.exe' };
  assert.equal(detectVariant({ packaged: true, env, execPath: installed }), 'portable');
  assert.equal(detectVariant({ packaged: true, env, execPath: programDir('portable') }), 'portable');
  // Une variable vide ne compte pas.
  assert.equal(detectVariant({ packaged: true, env: { PORTABLE_EXECUTABLE_FILE: '' }, execPath: programDir('vide') }), 'unpacked');
});

test('programme empaqueté sans désinstallateur, ou lancé depuis les sources : aucune mise à jour', () => {
  assert.equal(detectVariant({ packaged: true, env: {}, execPath: programDir('nu') }), 'unpacked');
  // Depuis les sources, rien d'autre n'est regardé.
  const installed = programDir('sources', { uninstaller: true });
  for (const packaged of [false, undefined, null, 'oui', 1]) assert.equal(detectVariant({ packaged, env: { PORTABLE_EXECUTABLE_FILE: 'x' }, execPath: installed }), 'development');
  assert.equal(detectVariant(), 'development');
  // Un disque qui ne répond pas ne fait pas passer le programme pour installé.
  const broken = {
    existsSync: () => {
      throw new Error('disque illisible');
    },
  };
  assert.equal(detectVariant({ packaged: true, env: {}, execPath: installed, fs: broken }), 'unpacked');
  assert.equal(detectVariant({ packaged: true, env: null, execPath: null }), 'unpacked');
  // Chaque réponse possible est connue du service des mises à jour.
  for (const variant of ['installed', 'portable', 'unpacked', 'development']) assert.ok(VARIANTS.includes(variant));
});
