/**
 * Tests des opérations sur les fichiers sur un VRAI disque : celui de la
 * machine qui exécute les tests (NTFS sur la machine de compilation Windows).
 *
 * Deux dossiers seulement sont autorisés — « Documents » et « Bureau » d'un
 * profil d'essai ; tout le reste du disque, à commencer par le dossier voisin
 * « Dehors », est hors des emplacements autorisés. La Corbeille est simulée
 * par un dossier d'essai : les éléments y sont déplacés, jamais détruits.
 *
 * Les règles propres à Windows (lettres de lecteur, dossiers du système,
 * lecteur réseau) sont éprouvées sur un faux disque dans
 * tests/file-operations.test.mjs.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const { createFilesService } = require('../src/services/files.js');
const { createFileOperations } = require('../src/services/file-operations.js');
const { ServiceError } = require('../src/services/hub.js');

const bases = [];
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true });
});

const CONFIRMED = Object.freeze({ confirmed: true });

/** Crée un lien vers un dossier : jonction sous Windows (aucun droit particulier), lien symbolique ailleurs. */
const linkTo = (target, location) => fs.symlinkSync(target, location, 'junction');

/** Profil d'essai : Documents et Bureau autorisés, « Dehors » non. */
function profile({ wrap = (module) => module, trash, openPath, limits } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'evolve-operations-')));
  bases.push(base);
  const at = (...parts) => path.join(base, ...parts);
  for (const dir of ['Documents/Projets/Été', 'Documents/Archives', 'Bureau', 'Dehors/Privé', 'Corbeille']) fs.mkdirSync(at(dir), { recursive: true });
  fs.writeFileSync(at('Documents', 'Lettre.txt'), 'Bonjour,\nceci est une lettre.\n');
  fs.writeFileSync(at('Documents', 'Budget.xlsx'), Buffer.alloc(4096, 7));
  fs.writeFileSync(at('Documents', 'Projets', 'plan.pdf'), Buffer.alloc(1500, 3));
  fs.writeFileSync(at('Documents', 'Projets', 'Été', 'photo.jpg'), Buffer.alloc(65_536, 9));
  fs.writeFileSync(at('Bureau', 'Notes.txt'), 'notes');
  fs.writeFileSync(at('Dehors', 'secret.txt'), 'hors des emplacements autorisés');
  fs.writeFileSync(at('Dehors', 'Privé', 'journal.txt'), 'journal');
  // Liens placés dans Documents : l'un mène hors des emplacements autorisés, l'autre au Bureau.
  linkTo(at('Dehors'), at('Documents', 'Vers dehors'));
  linkTo(at('Bureau'), at('Documents', 'Vers le Bureau'));

  const bin = [];
  const recycle = async (target) => {
    const kept = at('Corbeille', `${bin.length}-${path.basename(target)}`);
    fs.renameSync(target, kept);
    bin.push({ from: target, kept });
  };
  const opened = [];
  const files = createFilesService({ places: { documents: at('Documents'), desktop: at('Bureau') }, drives: [], env: {} });
  const operations = createFileOperations({
    guard: files.guard,
    fs: wrap(fs),
    env: {},
    trash: trash === undefined ? recycle : trash,
    openPath: openPath ?? (async (target) => (opened.push(target), '')),
    ...(limits ? { limits } : {}),
  });
  return { base, at, files, operations, bin, opened, docs: at('Documents'), desktop: at('Bureau') };
}

/** État d'un dossier : chaque élément, avec l'empreinte du contenu des fichiers. */
function snapshot(folder) {
  const lines = [];
  (function walk(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, item.name);
      const relative = path.relative(folder, full);
      if (item.isSymbolicLink()) lines.push(`${relative} -> lien`);
      else if (item.isDirectory()) {
        lines.push(`${relative}${path.sep}`);
        walk(full);
      } else lines.push(`${relative} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)}`);
    }
  })(folder);
  return lines;
}

const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const names = (folder) => fs.readdirSync(folder).sort();

async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, `erreur inattendue : ${error?.stack ?? error}`);
    return error.code;
  }
  return assert.fail('la demande aurait dû être refusée');
}

test('vrai disque — nouveau dossier, puis renommage d’un fichier et d’un dossier', async () => {
  const { at, docs, operations } = profile();
  const created = await operations.createFolder(docs, 'Factures 2026');
  assert.deepEqual(created, { path: at('Documents', 'Factures 2026'), name: 'Factures 2026' });
  assert.ok(fs.statSync(created.path).isDirectory());
  assert.deepEqual(fs.readdirSync(created.path), []);
  assert.equal(await codeOf(operations.createFolder(docs, 'Factures 2026')), 'collision');
  assert.equal(await codeOf(operations.createFolder(docs, 'Lettre.txt')), 'collision');

  const letter = digest(at('Documents', 'Lettre.txt'));
  const renamed = await operations.rename(at('Documents', 'Lettre.txt'), 'Courrier de mars.txt');
  assert.equal(renamed.path, at('Documents', 'Courrier de mars.txt'));
  assert.equal(digest(renamed.path), letter, 'contenu inchangé');
  assert.equal(fs.existsSync(at('Documents', 'Lettre.txt')), false);

  await operations.rename(at('Documents', 'Projets'), 'Projets 2026');
  assert.deepEqual(names(at('Documents', 'Projets 2026')), ['plan.pdf', 'Été']);
  // Seule la casse change : admis sur tout disque, sensible ou non à la casse.
  assert.equal((await operations.rename(at('Documents', 'Budget.xlsx'), 'BUDGET.xlsx')).name, 'BUDGET.xlsx');
  assert.ok(names(docs).includes('BUDGET.xlsx'));

  // Jamais vers un nom déjà pris : le fichier en place n'est pas remplacé.
  const budget = digest(at('Documents', 'BUDGET.xlsx'));
  assert.equal(await codeOf(operations.rename(at('Documents', 'Courrier de mars.txt'), 'BUDGET.xlsx')), 'collision');
  assert.equal(await codeOf(operations.rename(at('Documents', 'Courrier de mars.txt'), 'Archives')), 'collision');
  assert.equal(digest(at('Documents', 'BUDGET.xlsx')), budget);
  assert.equal(digest(at('Documents', 'Courrier de mars.txt')), letter);
});

test('vrai disque — copie de plusieurs éléments : contenus identiques, originaux intacts, liens laissés de côté', async () => {
  const { at, docs, desktop, operations } = profile();
  linkTo(at('Dehors'), at('Documents', 'Projets', 'Lien interne'));
  const before = snapshot(docs);
  const outside = snapshot(at('Dehors'));

  const report = await operations.copy([at('Documents', 'Projets'), at('Documents', 'Lettre.txt'), at('Documents', 'Budget.xlsx')], desktop);
  assert.equal(report.status, 'done');
  assert.deepEqual(report.done.map((item) => item.name), ['Projets', 'Lettre.txt', 'Budget.xlsx']);
  assert.deepEqual([report.failed, report.skipped, report.links], [[], [], 1]);
  assert.deepEqual(names(desktop), ['Budget.xlsx', 'Lettre.txt', 'Notes.txt', 'Projets']);
  // Octet pour octet.
  for (const relative of ['Lettre.txt', 'Budget.xlsx', path.join('Projets', 'plan.pdf'), path.join('Projets', 'Été', 'photo.jpg')]) {
    assert.equal(digest(at('Bureau', relative)), digest(at('Documents', relative)), relative);
  }
  // Le lien n'a été ni copié ni suivi : rien de « Dehors » n'est arrivé sur le Bureau.
  assert.deepEqual(names(at('Bureau', 'Projets')), ['plan.pdf', 'Été']);
  assert.deepEqual(snapshot(docs), before);
  assert.deepEqual(snapshot(at('Dehors')), outside);

  // Une seconde copie au même endroit : la question est posée, rien n'est remplacé.
  fs.writeFileSync(at('Bureau', 'Lettre.txt'), 'version modifiée sur le Bureau');
  const modified = digest(at('Bureau', 'Lettre.txt'));
  const asked = await operations.copy([at('Documents', 'Lettre.txt'), at('Documents', 'Projets')], desktop);
  assert.deepEqual([asked.status, asked.collisions.map((item) => item.name)], ['collisions', ['Lettre.txt', 'Projets']]);
  const kept = await operations.copy([at('Documents', 'Lettre.txt'), at('Documents', 'Projets')], desktop, { onCollision: 'keep-both' });
  assert.deepEqual(kept.done.map((item) => item.name), ['Lettre - Copie.txt', 'Projets - Copie']);
  assert.equal(digest(at('Bureau', 'Lettre.txt')), modified, 'le fichier en place n’a pas été remplacé');
  assert.equal(digest(at('Bureau', 'Lettre - Copie.txt')), digest(at('Documents', 'Lettre.txt')));
  assert.ok(names(desktop).every((name) => !/copie en cours|copie incomplète/.test(name)));
});

test('vrai disque — déplacement de plusieurs éléments, puis refus du déplacement d’un dossier dans lui-même', async () => {
  const { at, docs, operations, bin } = profile();
  const photo = digest(at('Documents', 'Projets', 'Été', 'photo.jpg'));
  const report = await operations.move([at('Documents', 'Projets'), at('Documents', 'Lettre.txt')], at('Documents', 'Archives'), CONFIRMED);
  assert.deepEqual(report.done.map((item) => item.path), [at('Documents', 'Archives', 'Projets'), at('Documents', 'Archives', 'Lettre.txt')]);
  assert.deepEqual(names(at('Documents', 'Archives')), ['Lettre.txt', 'Projets']);
  assert.equal(digest(at('Documents', 'Archives', 'Projets', 'Été', 'photo.jpg')), photo);
  assert.ok(!names(docs).includes('Projets') && !names(docs).includes('Lettre.txt'));
  assert.deepEqual(bin, []);

  const before = snapshot(docs);
  const folder = at('Documents', 'Archives', 'Projets');
  for (const destination of [folder, path.join(folder, 'Été')]) {
    assert.equal(await codeOf(operations.move([folder], destination, CONFIRMED)), 'into-itself');
    assert.equal(await codeOf(operations.copy([folder], destination)), 'into-itself');
  }
  // Par un lien qui ramène dans le dossier lui-même.
  linkTo(folder, at('Documents', 'Retour'));
  assert.equal(await codeOf(operations.move([folder], at('Documents', 'Retour', 'Été'), CONFIRMED)), 'into-itself');
  fs.rmSync(at('Documents', 'Retour'), { recursive: false, force: true });
  assert.deepEqual(snapshot(docs), before);

  // Nom déjà pris à destination : rien n'est remplacé.
  fs.writeFileSync(at('Documents', 'Lettre.txt'), 'autre lettre');
  const other = digest(at('Documents', 'Lettre.txt'));
  const asked = await operations.move([at('Documents', 'Archives', 'Lettre.txt')], docs, CONFIRMED);
  assert.equal(asked.status, 'collisions');
  assert.equal(digest(at('Documents', 'Lettre.txt')), other);
  assert.ok(fs.existsSync(at('Documents', 'Archives', 'Lettre.txt')));
});

test('vrai disque — déplacement vers un autre lecteur (simulé) : copie, puis original à la Corbeille', async () => {
  // Le système refuse de renommer d'un lecteur à l'autre (EXDEV) : simulé ici pour le dossier « Projets ».
  const wrap = (module) => ({
    ...module,
    rename: (from, to, callback) => {
      if (path.basename(from) === 'Projets' && path.basename(to) === 'Projets') callback(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }));
      else module.rename(from, to, callback);
    },
  });
  const { at, operations, bin } = profile({ wrap });
  const photo = digest(at('Documents', 'Projets', 'Été', 'photo.jpg'));
  const report = await operations.move([at('Documents', 'Projets')], at('Bureau'), CONFIRMED);
  assert.deepEqual(report.done, [{ source: at('Documents', 'Projets'), name: 'Projets', path: at('Bureau', 'Projets'), original: 'trashed' }]);
  assert.equal(digest(at('Bureau', 'Projets', 'Été', 'photo.jpg')), photo);
  // L'original n'a pas été détruit : il est, entier, dans la Corbeille.
  assert.equal(fs.existsSync(at('Documents', 'Projets')), false);
  assert.deepEqual(bin.map((item) => item.from), [at('Documents', 'Projets')]);
  assert.equal(digest(path.join(bin[0].kept, 'Été', 'photo.jpg')), photo);
});

test('vrai disque — suppression : plusieurs éléments rejoignent la Corbeille ; en échec, ils restent à leur place', async () => {
  const { at, docs, operations, bin } = profile();
  const report = await operations.trash([at('Documents', 'Lettre.txt'), at('Documents', 'Projets')], CONFIRMED);
  assert.deepEqual(report.done.map((item) => item.name), ['Lettre.txt', 'Projets']);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(names(docs), ['Archives', 'Budget.xlsx', 'Vers dehors', 'Vers le Bureau']);
  // Rien n'a été détruit : les éléments sont dans la Corbeille, entiers.
  assert.deepEqual(bin.map((item) => item.from), [at('Documents', 'Lettre.txt'), at('Documents', 'Projets')]);
  assert.equal(fs.readFileSync(bin[0].kept, 'utf8'), 'Bonjour,\nceci est une lettre.\n');
  assert.deepEqual(names(path.join(bin[1].kept, 'Été')), ['photo.jpg']);

  // Corbeille en échec : aucune suppression de secours.
  const failing = profile({ trash: async () => Promise.reject(new Error('Operation was aborted')) });
  const before = snapshot(failing.docs);
  const refused = await failing.operations.trash([failing.at('Documents', 'Lettre.txt'), failing.at('Documents', 'Projets')], CONFIRMED);
  assert.deepEqual([refused.done, refused.failed.map((item) => item.code)], [[], ['trash-failed', 'trash-failed']]);
  assert.deepEqual(snapshot(failing.docs), before);
  // Sans confirmation déclarée : refus.
  assert.equal(await codeOf(failing.operations.trash([failing.at('Documents', 'Lettre.txt')])), 'needs-confirmation');
});

test('vrai disque — chemins interdits, traversées et liens sortants : refusés, et rien ne change hors des emplacements autorisés', async () => {
  const { base, at, docs, desktop, operations, bin, opened } = profile();
  const everything = snapshot(base);
  const outsideBefore = snapshot(at('Dehors'));

  // Hors des emplacements autorisés (désigné directement, ou par une traversée).
  const outside = [at('Dehors', 'secret.txt'), at('Dehors'), at('Dehors', 'Privé')];
  for (const target of outside) {
    assert.equal(await codeOf(operations.rename(target, 'x')), 'outside-allowed', target);
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), 'outside-allowed', target);
    assert.equal(await codeOf(operations.copy([target], docs)), 'outside-allowed', target);
    assert.equal(await codeOf(operations.move([target], docs, CONFIRMED)), 'outside-allowed', target);
    assert.equal(await codeOf(operations.copy([at('Documents', 'Lettre.txt')], target)), 'outside-allowed', target);
    assert.equal(await codeOf(operations.createFolder(target, 'x')), 'outside-allowed', target);
    assert.equal(await codeOf(operations.open(target)), 'outside-allowed', target);
  }
  const traversals = [`${docs}${path.sep}..${path.sep}Dehors${path.sep}secret.txt`, `${docs}${path.sep}Projets${path.sep}..${path.sep}..${path.sep}Dehors`, `${docs}/../Dehors`, 'Documents/Lettre.txt', `..${path.sep}Dehors`, ''];
  for (const target of traversals) {
    assert.equal(await codeOf(operations.rename(target, 'x')), 'invalid-path', target);
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), 'invalid-path', target);
    assert.equal(await codeOf(operations.copy([at('Documents', 'Lettre.txt')], target)), 'invalid-path', target);
    assert.equal(await codeOf(operations.move([target], desktop, CONFIRMED)), 'invalid-path', target);
    assert.equal(await codeOf(operations.createFolder(target, 'x')), 'invalid-path', target);
  }

  // Un lien placé dans Documents mène dehors : rien ne passe par lui, et il n'est pas modifié lui-même.
  const through = at('Documents', 'Vers dehors');
  assert.equal(await codeOf(operations.createFolder(through, 'x')), 'leads-outside');
  assert.equal(await codeOf(operations.copy([at('Documents', 'Lettre.txt')], through)), 'leads-outside');
  assert.equal(await codeOf(operations.move([at('Documents', 'Lettre.txt')], through, CONFIRMED)), 'leads-outside');
  assert.equal(await codeOf(operations.copy([at('Documents', 'Projets')], path.join(through, 'Privé'))), 'leads-outside');
  assert.equal(await codeOf(operations.rename(path.join(through, 'secret.txt'), 'x.txt')), 'leads-outside');
  assert.equal(await codeOf(operations.trash([path.join(through, 'secret.txt')], CONFIRMED)), 'leads-outside');
  assert.equal(await codeOf(operations.copy([path.join(through, 'secret.txt')], docs)), 'leads-outside');
  assert.equal(await codeOf(operations.open(path.join(through, 'secret.txt'))), 'leads-outside');
  for (const target of [through, at('Documents', 'Vers le Bureau')]) {
    assert.equal(await codeOf(operations.rename(target, 'x')), 'link-not-supported');
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), 'link-not-supported');
    assert.equal(await codeOf(operations.copy([target], desktop)), 'link-not-supported');
    assert.equal(await codeOf(operations.move([target], desktop, CONFIRMED)), 'link-not-supported');
  }

  // Les emplacements de base ne sont l'objet d'aucune opération ; le dossier qui les contient est hors des emplacements autorisés.
  for (const [target, expected] of [[docs, 'protected'], [desktop, 'protected'], [base, 'outside-allowed']]) {
    assert.equal(await codeOf(operations.rename(target, 'x')), expected, target);
    assert.equal(await codeOf(operations.trash([target], CONFIRMED)), expected, target);
    assert.equal(await codeOf(operations.move([target], at('Documents', 'Archives'), CONFIRMED)), expected, target);
    assert.equal(await codeOf(operations.copy([target], at('Documents', 'Archives'))), expected, target);
  }

  assert.deepEqual(snapshot(base), everything, 'rien n’a changé, nulle part');
  assert.deepEqual([bin, opened], [[], []]);

  // Un lien vers un emplacement autorisé, lui, mène quelque part : l'élément arrive à l'emplacement réel.
  const viaLink = await operations.copy([at('Documents', 'Lettre.txt')], at('Documents', 'Vers le Bureau'));
  assert.deepEqual(viaLink.done.map((item) => item.path), [at('Bureau', 'Lettre.txt')]);
  assert.deepEqual(snapshot(at('Dehors')), outsideBefore);
});

test('vrai disque — copie d’un dossier interrompue : la copie partielle est marquée « incomplète », l’original est intact', async () => {
  // La copie de « photo.jpg » échoue (disque plein).
  const wrap = (module) => ({
    ...module,
    copyFile: (from, to, mode, callback) => {
      if (path.basename(from) === 'photo.jpg') callback(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
      else module.copyFile(from, to, mode, callback);
    },
  });
  const { at, docs, desktop, operations } = profile({ wrap });
  const before = snapshot(docs);
  const report = await operations.copy([at('Documents', 'Projets'), at('Documents', 'Lettre.txt')], desktop);
  assert.deepEqual(report.failed.map((item) => [item.name, item.code, item.at, item.partial]), [['Projets', 'no-space', path.join('Été', 'photo.jpg'), 'Projets (copie incomplète)']]);
  assert.deepEqual(report.done.map((item) => item.name), ['Lettre.txt']);
  assert.deepEqual(names(desktop), ['Lettre.txt', 'Notes.txt', 'Projets (copie incomplète)']);
  assert.deepEqual(snapshot(docs), before);
});

/** Refus de Windows quand un autre programme tient ouvert un fichier du dossier à renommer. */
const refusal = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
const isPending = (location) => path.basename(location).endsWith('(copie en cours)');

test('vrai disque — dossier copié : un refus passager du renommage final est surmonté ; un refus durable laisse la copie entière sous son nom provisoire', async () => {
  // Un antivirus examine les fichiers qui viennent d'être écrits : Windows refuse un instant de renommer leur dossier.
  let refusals = 2;
  const attempts = [];
  const wrap = (module) => ({
    ...module,
    rename: (from, to, callback) => {
      attempts.push(path.basename(to));
      if (isPending(from) && refusals > 0) {
        refusals -= 1;
        callback(refusal());
      } else module.rename(from, to, callback);
    },
  });
  const { at, docs, desktop, operations } = profile({ wrap, limits: { retries: 3, retryMs: 2 } });
  const before = snapshot(docs);

  const report = await operations.copy([at('Documents', 'Projets')], desktop);
  assert.deepEqual([report.done.map((item) => item.path), report.failed], [[at('Bureau', 'Projets')], []]);
  assert.deepEqual(attempts, ['Projets', 'Projets', 'Projets'], 'deux refus, puis le renommage');
  assert.deepEqual(names(desktop), ['Notes.txt', 'Projets']);
  assert.deepEqual(snapshot(at('Bureau', 'Projets')), snapshot(at('Documents', 'Projets')), 'copie identique');

  // Refus durable : l'échec est signalé après le nombre d'essais prévu. La copie est entière ; elle garde le nom
  // provisoire, qui ne la fait pas passer pour l'élément attendu.
  refusals = Infinity;
  attempts.length = 0;
  fs.writeFileSync(at('Documents', 'Archives', 'ancien.txt'), 'ancien');
  const second = await operations.copy([at('Documents', 'Archives')], desktop);
  assert.deepEqual(second.done, []);
  assert.deepEqual(second.failed.map((item) => [item.name, item.code, item.partial, item.complete]), [['Archives', 'access-denied', 'Archives (copie en cours)', true]]);
  assert.deepEqual(attempts, ['Archives', 'Archives', 'Archives', 'Archives'], 'un essai, puis trois nouveaux');
  assert.deepEqual(names(desktop), ['Archives (copie en cours)', 'Notes.txt', 'Projets']);
  assert.deepEqual(names(at('Bureau', 'Archives (copie en cours)')), ['ancien.txt']);

  // Copie interrompue par une erreur, et refus durable : le dossier partiel garde, lui aussi, son nom provisoire.
  const blocked = profile({
    wrap: (module) => ({
      ...wrap(module),
      copyFile: (_from, _to, _mode, callback) => callback(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })),
    }),
    limits: { retries: 1, retryMs: 2 },
  });
  const third = await blocked.operations.copy([blocked.at('Documents', 'Projets')], blocked.desktop);
  assert.deepEqual(third.failed.map((item) => [item.name, item.code, item.partial, item.complete]), [['Projets', 'no-space', 'Projets (copie en cours)', undefined]]);
  assert.deepEqual(names(blocked.desktop), ['Notes.txt', 'Projets (copie en cours)']);

  fs.rmSync(at('Documents', 'Archives', 'ancien.txt'));
  assert.deepEqual(snapshot(docs), before, 'les originaux sont intacts');
});

test('vrai disque — dossier copié : si le nom prévu est pris pendant l’attente, rien n’est remplacé', async () => {
  let taken = false;
  const wrap = (module) => ({
    ...module,
    rename: (from, to, callback) => {
      if (isPending(from) && !taken) {
        taken = true;
        // Au même instant, un autre programme crée un élément portant le nom prévu.
        fs.mkdirSync(to);
        fs.writeFileSync(path.join(to, 'autre.txt'), 'créé par un autre programme');
        callback(refusal());
      } else module.rename(from, to, callback);
    },
  });
  const { at, docs, desktop, operations } = profile({ wrap, limits: { retries: 3, retryMs: 2 } });
  const before = snapshot(docs);

  const report = await operations.copy([at('Documents', 'Projets')], desktop);
  assert.deepEqual(report.done, []);
  assert.deepEqual(report.failed.map((item) => [item.name, item.code, item.partial, item.complete]), [['Projets', 'collision', 'Projets (copie en cours)', true]]);
  // L'élément de l'autre programme est intact ; la copie, entière, est restée à côté sous son nom provisoire.
  assert.deepEqual(names(desktop), ['Notes.txt', 'Projets', 'Projets (copie en cours)']);
  assert.deepEqual(names(at('Bureau', 'Projets')), ['autre.txt']);
  assert.equal(fs.readFileSync(at('Bureau', 'Projets', 'autre.txt'), 'utf8'), 'créé par un autre programme');
  assert.deepEqual(snapshot(at('Bureau', 'Projets (copie en cours)')), snapshot(at('Documents', 'Projets')));
  assert.deepEqual(snapshot(docs), before);
});

test('vrai disque — permissions insuffisantes : l’échec est signalé, rien n’est modifié', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { at, docs, operations } = profile();
  const locked = at('Documents', 'Archives');
  fs.writeFileSync(path.join(locked, 'ancien.txt'), 'ancien');
  fs.chmodSync(locked, 0o555); // dossier en lecture seule
  try {
    assert.equal(await codeOf(operations.createFolder(locked, 'Nouveau')), 'access-denied');
    assert.equal(await codeOf(operations.rename(path.join(locked, 'ancien.txt'), 'nouveau.txt')), 'access-denied');
    const copied = await operations.copy([at('Documents', 'Lettre.txt'), at('Documents', 'Projets')], locked);
    assert.deepEqual([copied.done, copied.failed.map((item) => item.code)], [[], ['access-denied', 'access-denied']]);
    const moved = await operations.move([at('Documents', 'Lettre.txt')], locked, CONFIRMED);
    assert.deepEqual([moved.done, moved.failed.map((item) => item.code)], [[], ['access-denied']]);
    assert.deepEqual(names(locked), ['ancien.txt']);
    assert.ok(names(docs).includes('Lettre.txt') && names(docs).includes('Projets'));
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('vrai disque — ouvrir : le fichier est confié au système par son chemin réel ; un programme exige une confirmation', async () => {
  const { at, operations, opened } = profile();
  fs.writeFileSync(at('Documents', 'outil.exe'), 'MZ');
  fs.writeFileSync(at('Documents', 'script.BAT'), '@echo off');
  assert.equal((await operations.open(at('Documents', 'Lettre.txt'))).opened, true);
  await operations.open(path.join(at('Documents', 'Vers le Bureau'), 'Notes.txt'));
  assert.deepEqual(opened, [at('Documents', 'Lettre.txt'), at('Bureau', 'Notes.txt')]);
  for (const name of ['outil.exe', 'script.BAT']) assert.equal(await codeOf(operations.open(at('Documents', name))), 'needs-confirmation');
  assert.equal(opened.length, 2);
  await operations.open(at('Documents', 'outil.exe'), CONFIRMED);
  assert.deepEqual(opened.slice(2), [at('Documents', 'outil.exe')]);
  assert.equal(await codeOf(operations.open(at('Documents', 'Projets'))), 'not-a-file');
});
