/**
 * Lecture du niveau d'exécution demandé par un exécutable Windows
 * (scripts/check-manifest.mjs) : Evolve ne doit jamais demander de droits
 * administrateur.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { executionLevels, verdict } from '../scripts/check-manifest.mjs';
import { fromRoot } from './helpers.mjs';

const SCRIPT = fromRoot('scripts', 'check-manifest.mjs');
const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-manifest-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Manifeste d'application Windows, tel qu'incorporé dans un fichier .exe. */
const manifest = (level, { selfClosing = true } = {}) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="${level}" uiAccess="false"${selfClosing ? ' />' : '></requestedExecutionLevel>'}
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>`;

/** Faux exécutable : en-tête « MZ », données quelconques, manifeste(s). */
function fakeExe(...manifests) {
  const noise = Buffer.alloc(4096, 0x90);
  return Buffer.concat([Buffer.from('MZ'), noise, ...manifests.flatMap((item) => [Buffer.from(item), noise])]);
}

function writeExe(name, bytes) {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

const runScript = (...files) =>
  spawnSync(process.execPath, [SCRIPT, ...files], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' } });

/** Même exécution, telle que sur GitHub Actions : renvoie les annotations publiées. */
const annotations = (...files) =>
  spawnSync(process.execPath, [SCRIPT, ...files], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: 'true' } })
    .stdout.split('\n')
    .filter((line) => line.startsWith('::'));

test('lit le niveau d’exécution d’un manifeste en UTF-8', () => {
  assert.deepEqual(executionLevels(fakeExe(manifest('asInvoker'))), ['asInvoker']);
  assert.deepEqual(executionLevels(fakeExe(manifest('requireAdministrator'))), ['requireAdministrator']);
  assert.deepEqual(executionLevels(fakeExe(manifest('highestAvailable', { selfClosing: false }))), ['highestAvailable']);
});

test('lit le niveau d’exécution d’un manifeste en UTF-16', () => {
  const bytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(513), Buffer.from(manifest('requireAdministrator'), 'utf16le')]);
  assert.deepEqual(executionLevels(bytes), ['requireAdministrator']);
});

test('plusieurs manifestes : tous sont pris en compte', () => {
  const bytes = fakeExe(manifest('asInvoker'), manifest('requireAdministrator'));
  assert.deepEqual(executionLevels(bytes), ['asInvoker', 'requireAdministrator']);
  assert.equal(verdict(executionLevels(bytes)), 'elevation');
});

test('la balise fermante et les mentions sans niveau sont ignorées', () => {
  const bytes = fakeExe('texte requestedExecutionLevel sans attribut', manifest('asInvoker', { selfClosing: false }));
  assert.deepEqual(executionLevels(bytes), ['asInvoker']);
  assert.deepEqual(executionLevels(Buffer.from('MZ rien du tout')), []);
});

test('verdict', () => {
  assert.equal(verdict(['asInvoker']), 'ok');
  assert.equal(verdict(['asInvoker', 'asInvoker']), 'ok');
  assert.equal(verdict(['requireAdministrator']), 'elevation');
  assert.equal(verdict(['highestAvailable']), 'elevation');
  assert.equal(verdict([]), 'unknown');
});

test('en ligne de commande : réussite seulement sans demande d’élévation', () => {
  const user = writeExe('utilisateur.exe', fakeExe(manifest('asInvoker')));
  const admin = writeExe('administrateur.exe', fakeExe(manifest('requireAdministrator')));
  const plain = writeExe('sans-manifeste.exe', fakeExe());

  const ok = runScript(user);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /✔ .*utilisateur\.exe : niveau « asInvoker »/);

  const elevated = runScript(user, admin);
  assert.equal(elevated.status, 1);
  assert.match(elevated.stderr, /✖ .*administrateur\.exe : demande une élévation de droits \(requireAdministrator\)/);

  const unknown = runScript(plain);
  assert.equal(unknown.status, 0, 'un manifeste illisible est signalé sans bloquer');
  assert.match(unknown.stderr, /aucun niveau d'exécution lisible/);

  const missing = runScript(path.join(workDir, 'absent.exe'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /fichier introuvable/);
});

test('sur GitHub Actions, le verdict est publié en annotation', () => {
  const user = writeExe('a-utilisateur.exe', fakeExe(manifest('asInvoker')));
  const admin = writeExe('a-administrateur.exe', fakeExe(manifest('requireAdministrator')));
  const plain = writeExe('a-sans-manifeste.exe', fakeExe());

  const ok = annotations(user);
  assert.equal(ok.length, 1);
  assert.match(ok[0], /^::notice title=Droits demandés à Windows::✔ .*a-utilisateur\.exe : asInvoker \(aucun droit administrateur demandé\)$/);

  const elevated = annotations(user, admin);
  assert.equal(elevated.length, 1);
  assert.match(elevated[0], /^::error title=Droits demandés à Windows::✔ .*%0A✖ .*a-administrateur\.exe : élévation demandée \(requireAdministrator\)$/);

  assert.match(annotations(user, plain)[0], /^::warning title=Droits demandés à Windows::.*%0A! .*a-sans-manifeste\.exe : niveau d'exécution non lisible$/);
  assert.match(annotations(path.join(workDir, 'absent.exe'))[0], /^::error title=Droits demandés à Windows::✖ .*absent\.exe : fichier introuvable$/);

  assert.ok(!runScript(user).stdout.includes('::'), 'aucune annotation hors de GitHub Actions');
});
