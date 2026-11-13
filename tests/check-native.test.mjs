/**
 * Tests de la vérification « renommer ou déplacer ne remplace jamais rien »
 * (src/main/selftest-no-replace.js) et du script qui l'applique au module
 * natif compilé (scripts/check-native.mjs).
 *
 * La vérification est d'abord menée sur le vrai module natif, sur le disque
 * de la machine qui exécute les tests. Elle est ensuite confrontée à des
 * fonctions de déplacement fautives — dont le renommage de Node, qui
 * remplace, et l'ancienne façon de faire, « vérifier puis renommer » — pour
 * constater qu'elle les démasque toutes.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { findOtherVolume, importedLibraries, NOT_IN_WINDOWS, parseOptions, sha256 } from '../scripts/check-native.mjs';
import { fromRoot, loadNativeMove } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { ADDON_FILE } = require('../src/main/atomic-move.js');
const { verifyNoReplace, describeFacts, summarizeFacts, snapshot, CHECK, FOLDER_NAME, DEFAULT_ROUNDS, DEFAULT_MOVERS, TRANSIENT } = require('../src/main/selftest-no-replace.js');

/** Le vrai module natif, chargé comme l'application le charge. */
const nativeMove = loadNativeMove();

const bases = [];
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true });
});

/** Dossier d'essai vide (chemin réel), dans `parent`. */
function workDir(parent = tmpdir()) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'evolve-verif-')));
  bases.push(base);
  return base;
}

/** Dossier d'un autre lecteur que le dossier temporaire, s'il en existe un sur cette machine. */
const otherVolume = findOtherVolume(fs.realpathSync.native(tmpdir()));

const exists = (location) => {
  try {
    fs.lstatSync(location);
    return true;
  } catch {
    return false;
  }
};
const taken = (to) => Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST', errno: 17 });

// ---------------------------------------------------------------------------------
// Le vrai module natif
// ---------------------------------------------------------------------------------

test('vérification — le module natif ne remplace jamais rien : nom libre, nom pris, casse, courses, autre lecteur', async () => {
  const base = workDir();
  const elsewhere = otherVolume ? workDir(otherVolume) : null;
  const { ok, problems, facts } = await verifyNoReplace(nativeMove, { base, rounds: 12, otherVolume: elsewhere });

  assert.deepEqual(problems, []);
  assert.equal(ok, true);
  // Quatre déplacements vers un nom libre, plus un cinquième par un chemin de plus de 260 caractères.
  assert.deepEqual([facts.free, facts.longPath], [5, true]);
  const deepest = snapshot(base).split('\n').reduce((most, line) => Math.max(most, line.length), 0);
  assert.ok(deepest > 360, `chemin le plus long : ${deepest} caractères`);
  // Fichier ou dossier, vers le nom d'un fichier, d'un dossier vide, d'un dossier non vide, d'un lien.
  assert.equal(facts.taken.cases, facts.link ? 8 : 6);
  assert.equal(facts.taken.numbers.length >= 1 && facts.taken.numbers.every((number) => Number.isInteger(number) && number > 0), true);
  assert.equal(facts.caseOnly, 2);
  // 12 courses entre fichiers, 12 entre dossiers, et autant entre un déplacement et une création.
  assert.deepEqual([facts.races.rounds, facts.contests.rounds], [48, 24]);
  assert.equal(facts.races.requests, 12 * DEFAULT_MOVERS + 12 * 4 + 24 * 2);
  // Une demande aboutie par course — déplacement ou création — et aucune perte.
  assert.equal(facts.races.moved + facts.contests.creator, 48);
  assert.equal(facts.races.refused, 12 * (DEFAULT_MOVERS - 1) + 12 * 3 + facts.contests.creator);
  assert.equal(facts.contests.creator + facts.contests.mover, 24);
  assert.equal(facts.races.lost, 0);
  if (elsewhere) {
    assert.equal(facts.crossVolume.refused, 2);
    assert.deepEqual(fs.readdirSync(elsewhere), [], "rien n'a été copié sur l'autre lecteur");
  } else {
    assert.equal(facts.crossVolume, null);
  }

  // Rien n'est supprimé par la vérification : les éléments d'essai sont restés dans le dossier confié.
  assert.deepEqual(fs.readdirSync(base).sort(), ['1 - nom libre', '2 - nom déjà pris', '3 - casse', '4 - concurrence', ...(elsewhere ? ['5 - autre lecteur'] : [])]);
  assert.ok(snapshot(base).split('\n').length > 300);

  // Compte rendu.
  const lines = describeFacts(facts);
  assert.match(lines[0], /^✔ nom libre : 5 déplacements aboutis/);
  assert.match(lines[1], /^✔ nom déjà pris : refusé par le système dans les \d cas .* ; rien n'a été modifié — code du système : \d+/);
  assert.match(lines[3], /^✔ concurrence : 48 courses, 192 demandes simultanées — une seule aboutie par course \(\d+ déplacements, \d+ créations\), \d+ déplacements refusés, aucun élément remplacé ni perdu$/);
  assert.equal(lines.some((line) => line.startsWith("✔ d'un lecteur à l'autre")), Boolean(elsewhere));
  assert.match(summarizeFacts(facts), /^Sans remplacement : \d déplacements vers un nom déjà pris refusés par le système \(code \d+\) · 48 courses, 192 demandes simultanées, aucun élément remplacé ni perdu$/);
});

test('vérification — sans le cas du chemin long : quatre déplacements vers un nom libre, aucun chemin démesuré', async () => {
  const base = workDir();
  const { ok, problems, facts } = await verifyNoReplace(nativeMove, { base, rounds: 1, movers: 3, longPath: false });
  assert.deepEqual([ok, problems], [true, []]);
  assert.deepEqual([facts.free, facts.longPath, facts.caseOnly], [4, false, 2]);
  // Trois déplacements simultanés par course entre fichiers, trois entre dossiers, puis deux duels.
  assert.deepEqual([facts.races.rounds, facts.races.requests, facts.races.lost], [4, 3 + 3 + 2 + 2, 0]);
  assert.ok(snapshot(base).split('\n').every((line) => line.length < 100));
  assert.equal(describeFacts(facts)[0], '✔ nom libre : 4 déplacements aboutis (noms accentués, autre dossier)');
});

test('vérification — constantes et résumé : un compte rendu absent ou incomplet ne donne aucun résumé', () => {
  assert.equal(CHECK, "renommer ou déplacer ne remplace jamais rien : le système refuse lui-même un nom déjà pris et, de plusieurs déplacements simultanés vers un même nom, un seul aboutit");
  assert.equal(FOLDER_NAME, 'Déplacements sans remplacement');
  assert.deepEqual([DEFAULT_ROUNDS, DEFAULT_MOVERS], [40, 8]);
  // Un nom déjà pris n'est jamais un refus passager : la demande n'est pas renouvelée.
  assert.deepEqual([...TRANSIENT], ['EBUSY', 'EPERM', 'EACCES']);
  assert.ok(Object.isFrozen(TRANSIENT));
  for (const facts of [null, undefined, {}, 'oui', { free: 5 }, { free: 5, taken: { cases: 8 }, caseOnly: 2, races: { rounds: 4, requests: '16', lost: 0 } }, { free: 5, taken: { cases: -1 }, caseOnly: 2, races: { rounds: 4, requests: 16, lost: 0 } }]) {
    assert.equal(summarizeFacts(facts), null);
  }
  assert.equal(
    summarizeFacts({ free: 5, taken: { cases: 8, numbers: [183, 'x', 80] }, caseOnly: 2, races: { rounds: 40, requests: 160, lost: 0 } }),
    'Sans remplacement : 8 déplacements vers un nom déjà pris refusés par le système (code 183, 80) · 40 courses, 160 demandes simultanées, aucun élément remplacé ni perdu',
  );
  assert.equal(
    summarizeFacts({ free: 5, taken: { cases: 7 }, caseOnly: 2, races: { rounds: 40, requests: 160, lost: 12 } }),
    'Sans remplacement : 7 déplacements vers un nom déjà pris refusés par le système · 40 courses, 160 demandes simultanées, 12 élément(s) remplacé(s) ou perdu(s)',
  );
});

// ---------------------------------------------------------------------------------
// Fonctions fautives : la vérification doit les démasquer
// ---------------------------------------------------------------------------------

test('vérification — le renommage de Node, qui remplace, est démasqué : dès le nom déjà pris, puis dans chaque course', async () => {
  const { ok, problems, facts } = await verifyNoReplace((from, to) => fs.promises.rename(from, to), { base: workDir(), rounds: 3 });
  assert.equal(ok, false);
  // Un fichier déplacé vers le nom d'un fichier : remplacé (sur tout système).
  assert.ok(problems.includes("nom déjà pris (un fichier vers le nom d'un fichier) : le déplacement a abouti — l'occupant a été remplacé"), problems.join('\n'));
  // Courses entre fichiers : tous les déplacements aboutissent, chacun remplaçant le précédent.
  assert.ok(problems.some((message) => /^course 1 entre 8 fichiers : [2-8] déplacements ont abouti vers le même nom, au lieu d'un seul$/.test(message)), problems.join('\n'));
  assert.ok(problems.some((message) => /^course 1 entre 8 fichiers : [1-7] élément\(s\) remplacé\(s\) — leur contenu a disparu$/.test(message)), problems.join('\n'));
  assert.ok(facts.races.lost > 0);
});

test('vérification — « vérifier puis renommer » est démasqué par les courses, même s’il refuse un nom pris de longue date', async () => {
  // L'ancienne façon de faire : constater que le nom est libre, puis renommer. Entre les deux, un autre
  // déplacement peut prendre le nom — et le renommage remplace alors son élément.
  const checkThenRename = async (from, to) => {
    if (await fs.promises.lstat(to).then(() => true, () => false)) throw taken(to);
    await fs.promises.rename(from, to);
  };
  const { ok, problems, facts } = await verifyNoReplace(checkThenRename, { base: workDir(), rounds: 6 });
  assert.equal(ok, false);
  // Devant un nom pris de longue date, cette fonction refuse bien…
  assert.ok(!problems.some((message) => message.startsWith('nom déjà pris')), problems.join('\n'));
  // … mais pas quand plusieurs déplacements visent le même nom au même instant.
  assert.ok(problems.some((message) => /déplacements ont abouti vers le même nom, au lieu d'un seul$/.test(message)), problems.join('\n'));
  assert.ok(facts.races.lost > 0, 'des éléments ont été remplacés');
});

test('vérification — autres fautes démasquées : ne rien faire, déplacer sans signaler, mal nommer le refus, copier vers un autre lecteur', async () => {
  // Prétend avoir déplacé, sans rien faire.
  const idle = await verifyNoReplace(async () => {}, { base: workDir(), rounds: 1 });
  assert.equal(idle.ok, false);
  assert.ok(idle.problems.some((message) => message.startsWith("nom libre (un fichier, nom accentué) : l'élément n'est pas arrivé intact")), idle.problems.join('\n'));
  assert.ok(idle.problems.some((message) => message.startsWith('nom déjà pris') && message.endsWith("l'occupant a été remplacé")));

  // Refuse tout, même un nom libre.
  const stubborn = await verifyNoReplace(async (_from, to) => Promise.reject(taken(to)), { base: workDir(), rounds: 1 });
  assert.equal(stubborn.ok, false);
  assert.ok(stubborn.problems.includes('nom libre (un fichier, nom accentué) : déplacement refusé — EEXIST, code du système 17'), stubborn.problems.join('\n'));
  assert.ok(stubborn.problems.some((message) => /^course 1 entre 8 fichiers : 0 déplacements ont abouti/.test(message)));
  assert.equal(stubborn.facts.taken.cases, stubborn.facts.link ? 8 : 6, 'les refus devant un nom pris, eux, sont justes');

  // Refuse un nom pris, mais sous un autre code : l'application n'y reconnaîtrait pas un nom déjà pris.
  const misnamed = await verifyNoReplace(
    async (from, to) => {
      if (exists(to) && path.basename(to).toLowerCase() !== path.basename(from).toLowerCase()) throw Object.assign(new Error('refus'), { code: 'EINVAL', errno: 22 });
      return nativeMove(from, to);
    },
    { base: workDir(), rounds: 1 },
  );
  assert.equal(misnamed.ok, false);
  assert.ok(misnamed.problems.includes("nom déjà pris (un fichier vers le nom d'un fichier) : refus attendu « EEXIST », obtenu « EINVAL » (code du système 22)"), misnamed.problems.join('\n'));

  // Un refus durable « élément utilisé » n'est pas pris pour un refus de nom déjà pris.
  let calls = 0;
  const busy = await verifyNoReplace(async () => ((calls += 1), Promise.reject(Object.assign(new Error('occupé'), { code: 'EBUSY', errno: 16 }))), { base: workDir(), rounds: 1, movers: 2 });
  assert.equal(busy.ok, false);
  assert.ok(busy.problems.includes("nom déjà pris (un fichier vers le nom d'un fichier) : refus attendu « EEXIST », obtenu « EBUSY » (code du système 16)"), busy.problems.join('\n'));
  assert.ok(busy.facts.transient > 0 && calls > busy.facts.transient, 'les refus passagers sont renouvelés, puis signalés');

  // Aucune fonction : l'échec est immédiat, et rien n'est créé.
  const base = workDir();
  for (const missing of [null, undefined, 'moveNoReplace', {}]) {
    assert.deepEqual(await verifyNoReplace(missing, { base }).then((result) => [result.ok, result.problems]), [false, ['fonction de déplacement sans remplacement absente']]);
  }
  assert.deepEqual(fs.readdirSync(base), []);
});

test(
  'vérification — copier d’un lecteur à l’autre au lieu de refuser est démasqué',
  { skip: otherVolume ? false : 'un seul lecteur sur cette machine' },
  async () => {
    // Faute : devant un autre lecteur, copier le fichier au lieu de refuser (ce que ferait MOVEFILE_COPY_ALLOWED).
    const copying = async (from, to) => {
      try {
        await nativeMove(from, to);
      } catch (error) {
        if (error.code !== 'EXDEV' || !fs.statSync(from).isFile()) throw error;
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      }
    };
    const { ok, problems } = await verifyNoReplace(copying, { base: workDir(), rounds: 1, otherVolume: workDir(otherVolume) });
    assert.equal(ok, false);
    assert.deepEqual(problems, ["d'un lecteur à l'autre (un fichier) : le déplacement a abouti, alors qu'il ne peut se faire que par copie", "d'un lecteur à l'autre (un dossier) : refusé (EXDEV), mais un élément a été modifié ou copié"]);
  },
);

test('vérification — une panne du disque d’essai est rapportée comme un problème, sans exception', async () => {
  // Dossier d'essai absent : chaque partie de la vérification échoue, et le dit.
  const { ok, problems } = await verifyNoReplace(nativeMove, { base: path.join(workDir(), 'absent', 'plus loin'), rounds: 1 }).then(
    (result) => result,
    (error) => assert.fail(`exception inattendue : ${error.message}`),
  );
  assert.equal(ok, true, 'un dossier absent est simplement créé');
  assert.deepEqual(problems, []);

  // Dossier d'essai inutilisable : son nom est celui d'un fichier.
  const file = path.join(workDir(), 'fichier.txt');
  fs.writeFileSync(file, 'x');
  const broken = await verifyNoReplace(nativeMove, { base: file, rounds: 1 });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.problems.map((message) => message.split(' : ')[0]), ['nom libre', 'nom déjà pris', 'casse', 'concurrence']);
  assert.ok(broken.problems.every((message) => message.includes('vérification interrompue — ')));
});

// ---------------------------------------------------------------------------------
// Le script
// ---------------------------------------------------------------------------------

test('script — recherche d’un autre lecteur : le premier dossier accessible situé sur un autre volume, sinon rien', () => {
  const base = workDir();
  const sibling = workDir();
  // Même lecteur, dossier absent, fichier, valeurs vides : rien.
  const file = path.join(base, 'fichier.txt');
  fs.writeFileSync(file, 'x');
  assert.equal(findOtherVolume(base, [sibling, base, path.join(base, 'absent'), file, '', null, undefined, 42]), null);
  assert.equal(findOtherVolume(path.join(base, 'absent'), [sibling]), null);
  assert.equal(findOtherVolume(base, []), null);
  if (otherVolume) {
    assert.notEqual(fs.statSync(otherVolume).dev, fs.statSync(base).dev);
    assert.equal(findOtherVolume(base, [sibling, path.join(base, 'absent'), otherVolume, tmpdir()]), otherVolume);
    assert.equal(findOtherVolume(otherVolume, [otherVolume, base]), base);
  }
});

test('script — options de la ligne de commande', () => {
  assert.deepEqual(parseOptions([]), { module: null, record: null, expect: null, rounds: 40, otherVolume: null });
  assert.deepEqual(parseOptions(['--module=dist/x.node', '--record=a.sha256', '--expect=b.sha256', '--rounds=5', '--other-volume=D:\\a']), {
    module: 'dist/x.node',
    record: 'a.sha256',
    expect: 'b.sha256',
    rounds: 5,
    otherVolume: 'D:\\a',
  });
  for (const bad of ['--rounds=0', '--rounds=-3', '--rounds=douze', '--rounds=', '--rounds=99999', '--module=', '--record=', '--expect=', '--same-as=x.node', '--inconnue=1', 'module.node', '--module']) {
    assert.throws(() => parseOptions([bad]), new RegExp(`^Error: Option inconnue ou invalide : ${bad.replace(/[\\.]/g, '\\$&')}$`), bad);
  }
});

/** Exécute le script ; renvoie son code de sortie et ce qu'il a affiché. */
function runScript(args, env = {}) {
  const summary = path.join(workDir(), 'resume.md');
  const result = spawnSync(process.execPath, [fromRoot('scripts', 'check-native.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: summary, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
}

test('script — module compilé : vérification réussie, compte rendu, annotation et résumé ; les dossiers d’essai sont retirés', () => {
  const leftovers = () => fs.readdirSync(tmpdir()).filter((name) => name.startsWith('evolve-natif-')).length;
  const before = leftovers();
  const { code, out, err, summary } = runScript(['--rounds=3'], { GITHUB_ACTIONS: 'true' });
  assert.equal(code, 0, err);
  const fingerprint = sha256(ADDON_FILE);
  assert.ok(out.startsWith(`Module : ${path.join('native', 'build', 'Release', 'evolve_fs.node')} (${fs.statSync(ADDON_FILE).size} octets, SHA-256 ${fingerprint})\nSystème : ${process.platform} ${process.arch}, Node.js ${process.versions.node}\n✔ nom libre : 5 déplacements aboutis`), out);
  assert.match(out, /\n✔ nom déjà pris : refusé par le système dans les \d cas/);
  assert.match(out, /\n✔ seule la casse du nom change : accepté \(2 cas\)\n/);
  assert.match(out, /\n✔ concurrence : 12 courses, 48 demandes simultanées — une seule aboutie par course/);
  assert.match(out, otherVolume ? /\n✔ d'un lecteur à l'autre \(.+ → .+\) : refusé sans rien copier \(2 cas\)/ : /\n! d'un lecteur à l'autre : non vérifié \(un seul lecteur disponible sur cette machine\)\n/);
  assert.match(out, /\n✔ Renommer ou déplacer ne remplace jamais rien sur cette machine, même en cas de concurrence\.\n/);
  // Sur la page de la compilation : une annotation, et un résumé.
  assert.match(out, new RegExp(`\\n::${otherVolume ? 'notice' : 'warning'} title=Déplacement sans remplacement::Module %3A|\\n::${otherVolume ? 'notice' : 'warning'} title=Déplacement sans remplacement::Module : `));
  assert.ok(summary.startsWith('### 🔒 Déplacement sans remplacement\n\n```\nModule : '), summary);
  assert.equal(leftovers(), before, 'aucun dossier d’essai ne reste dans le dossier temporaire');
});

test('script — module absent, différent du module éprouvé, ou inutilisable : échec, et la raison est dite', () => {
  const dir = workDir();
  const absent = runScript([`--module=${path.join(dir, 'absent.node')}`], { GITHUB_ACTIONS: 'true' });
  assert.equal(absent.code, 1);
  assert.match(absent.err, /^✖ Module natif introuvable : .*absent\.node\nCompilez-le avec « npm run build:native »\.\n\n✖ Déplacement sans remplacement non garanti : l'exécutable ne doit pas être distribué\.\n$/);
  assert.match(absent.out, /^::error title=Déplacement sans remplacement::✖ Module natif introuvable/);
  assert.ok(absent.summary.startsWith('### ❌ Déplacement sans remplacement : échec'));

  // Le module éprouvé : son empreinte est inscrite dans un fichier, après la vérification.
  const record = path.join(dir, 'relevé', 'evolve_fs.sha256');
  const recorded = runScript([`--record=${record}`, '--rounds=1']);
  assert.equal(recorded.code, 0, recorded.err);
  assert.equal(fs.readFileSync(record, 'utf8'), `${sha256(ADDON_FILE)}  evolve_fs.node\n`);
  assert.match(recorded.out, /\n✔ empreinte inscrite dans .*evolve_fs\.sha256\n/);
  assert.equal(recorded.out.includes('::'), false, 'hors de GitHub Actions, aucune annotation');

  // Copie identique (le module embarqué dans l'exécutable) : même empreinte, acceptée — et éprouvée à son tour.
  const copy = path.join(dir, 'copie.node');
  fs.copyFileSync(ADDON_FILE, copy);
  const same = runScript([`--module=${copy}`, `--expect=${record}`, '--rounds=1'], { GITHUB_ACTIONS: 'true' });
  assert.equal(same.code, 0, same.err);
  assert.match(same.out, /\n✔ même empreinte que le module compilé puis éprouvé avant les tests \(.*evolve_fs\.sha256\)\n/);
  assert.match(same.out, /\n::(?:notice|warning) title=Déplacement sans remplacement — module embarqué dans l'exécutable::Module /);
  assert.ok(same.summary.startsWith("### 🔒 Déplacement sans remplacement — module embarqué dans l'exécutable\n"), same.summary);

  // Copie modifiée : refusée, sans être chargée ni éprouvée.
  fs.appendFileSync(copy, 'x');
  const different = runScript([`--module=${copy}`, `--expect=${record}`], { GITHUB_ACTIONS: 'true' });
  assert.equal(different.code, 1);
  assert.match(different.err, new RegExp(`\\n✖ Ce module n'est pas celui qui a été compilé puis éprouvé \\(SHA-256 ${sha256(ADDON_FILE)}, inscrite dans .*evolve_fs\\.sha256\\)\\.\\n`));
  assert.doesNotMatch(different.err, /nom libre|introuvable ou inutilisable/);
  assert.match(different.out, /^::error title=Déplacement sans remplacement — module embarqué dans l'exécutable::/);
  // Empreinte de référence absente, ou illisible : refus.
  const unreadable = path.join(dir, 'illisible.sha256');
  fs.writeFileSync(unreadable, 'pas une empreinte\n');
  for (const reference of [path.join(dir, 'absent.sha256'), unreadable, dir]) {
    const missing = runScript([`--expect=${reference}`]);
    assert.equal(missing.code, 1, reference);
    assert.match(missing.err, /\n✖ Empreinte de référence introuvable ou illisible : /, reference);
  }
  // Une vérification en échec n'inscrit aucune empreinte.
  const unwritten = path.join(dir, 'jamais.sha256');
  assert.equal(runScript([`--module=${copy}`, `--expect=${record}`, `--record=${unwritten}`]).code, 1);
  assert.equal(fs.existsSync(unwritten), false);

  // Un fichier qui n'est pas un module natif.
  const fake = path.join(dir, 'faux.node');
  fs.writeFileSync(fake, 'ceci n’est pas un module natif');
  const unusable = runScript([`--module=${fake}`]);
  assert.equal(unusable.code, 1);
  assert.match(unusable.err, /\n✖ Déplacement sans remplacement : module natif introuvable ou inutilisable \(/);

  const badOption = runScript(['--rounds=zéro']);
  assert.equal(badOption.code, 1);
  assert.match(badOption.err, /^✖ Option inconnue ou invalide : --rounds=zéro\n/);
});

// ---------------------------------------------------------------------------------
// Bibliothèques dont dépend le module (Windows)
// ---------------------------------------------------------------------------------

/**
 * Faux module Windows (format PE), réduit à ce que le script y lit : les en-têtes, une section, et
 * les deux listes de bibliothèques — chargées d'emblée (`required`) ou au premier usage (`delayed`).
 */
function fakeWindowsModule({ required = [], delayed = [], bits = 64 } = {}) {
  const data = Buffer.alloc(0x1000);
  data.writeUInt16LE(0x5a4d, 0); // « MZ »
  data.writeUInt32LE(0x80, 0x3c); // adresse de l'en-tête PE
  data.writeUInt32LE(0x00004550, 0x80); // « PE »
  data.writeUInt16LE(1, 0x80 + 6); // une section
  const optionalSize = bits === 64 ? 240 : 224;
  data.writeUInt16LE(optionalSize, 0x80 + 20);
  const optional = 0x80 + 24;
  data.writeUInt16LE(bits === 64 ? 0x20b : 0x10b, optional);
  const directories = optional + (bits === 64 ? 112 : 96);
  data.writeUInt32LE(16, directories - 4); // nombre de répertoires
  // La section : chargée à l'adresse 0x2000, rangée dans le fichier à partir de 0x400.
  const section = optional + optionalSize;
  data.writeUInt32LE(0x800, section + 8);
  data.writeUInt32LE(0x2000, section + 12);
  data.writeUInt32LE(0x800, section + 16);
  data.writeUInt32LE(0x400, section + 20);
  const addressOf = (offset) => offset - 0x400 + 0x2000;
  let next = 0x800;
  const nameAddress = (name) => {
    const at = next;
    next += data.write(`${name}\0`, at, 'latin1');
    return addressOf(at);
  };
  // Bibliothèques chargées d'emblée : 20 octets chacune, nom au douzième ; liste close par une entrée vide.
  required.forEach((name, index) => data.writeUInt32LE(nameAddress(name), 0x400 + index * 20 + 12));
  if (required.length) data.writeUInt32LE(addressOf(0x400), directories + 1 * 8);
  // Bibliothèques chargées au premier usage : 32 octets chacune, nom au quatrième.
  delayed.forEach((name, index) => data.writeUInt32LE(nameAddress(name), 0x600 + index * 32 + 4));
  if (delayed.length) data.writeUInt32LE(addressOf(0x600), directories + 13 * 8);
  return data;
}

test('script — bibliothèques dont dépend un module Windows : lues dans le fichier, en 64 comme en 32 bits', () => {
  const dir = workDir();
  const write = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };
  for (const bits of [64, 32]) {
    const file = write(`module-${bits}.node`, fakeWindowsModule({ required: ['KERNEL32.dll', 'ADVAPI32.dll'], delayed: ['node.exe'], bits }));
    assert.deepEqual(importedLibraries(file), { required: ['KERNEL32.dll', 'ADVAPI32.dll'], delayed: ['node.exe'] }, `${bits} bits`);
  }
  assert.deepEqual(importedLibraries(write('seul.node', fakeWindowsModule())), { required: [], delayed: [] });
  // Un fichier d'un autre format — texte, module d'un autre système, fichier tronqué — n'est pas lu.
  assert.equal(importedLibraries(write('texte.node', 'MZ, mais ce n’est qu’un texte')), null);
  assert.equal(importedLibraries(write('vide.node', '')), null);
  assert.equal(importedLibraries(write('tronque.node', fakeWindowsModule({ required: ['KERNEL32.dll'] }).subarray(0, 0x90))), null);
  if (process.platform !== 'win32') assert.equal(importedLibraries(ADDON_FILE), null, 'module compilé pour un autre système que Windows');

  // Bibliothèques qui ne font pas partie de Windows : celles de Visual C++, à installer à part.
  for (const name of ['VCRUNTIME140.dll', 'vcruntime140_1.dll', 'MSVCP140.dll', 'msvcr120.dll', 'CONCRT140.dll', 'VCOMP140.DLL']) assert.ok(NOT_IN_WINDOWS.test(name), name);
  // Celles de Windows lui-même, bibliothèque C universelle comprise.
  for (const name of ['KERNEL32.dll', 'msvcrt.dll', 'ucrtbase.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'ntdll.dll', 'node.exe', 'ADVAPI32.dll']) assert.ok(!NOT_IN_WINDOWS.test(name), name);
});

test('script — un module qui dépend d’une bibliothèque absente d’un Windows neuf est refusé, sans être chargé', () => {
  const dir = workDir();
  const dependent = path.join(dir, 'dependant.node');
  fs.writeFileSync(dependent, fakeWindowsModule({ required: ['KERNEL32.dll', 'VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'], delayed: ['node.exe'] }));
  const refused = runScript([`--module=${dependent}`]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /\nBibliothèques requises : KERNEL32\.dll, VCRUNTIME140\.dll, api-ms-win-crt-runtime-l1-1-0\.dll ; au premier usage : node\.exe \(le programme qui charge le module\)\n✖ Le module dépend de VCRUNTIME140\.dll, absent d'un Windows fraîchement installé : l'exécutable ne serait plus portable\.\n/);
  assert.doesNotMatch(refused.err, /introuvable ou inutilisable/, 'le module n’a pas été chargé');

  // Sans une telle dépendance, la liste est affichée et la vérification se poursuit (ici, jusqu'au chargement, qui échoue : le module est faux).
  const sound = path.join(dir, 'autonome.node');
  fs.writeFileSync(sound, fakeWindowsModule({ required: ['KERNEL32.dll'], delayed: ['node.exe'] }));
  const loaded = runScript([`--module=${sound}`]);
  assert.equal(loaded.code, 1);
  assert.match(loaded.err, /\n✔ Bibliothèques requises : KERNEL32\.dll ; au premier usage : node\.exe \(le programme qui charge le module\)\n✖ Déplacement sans remplacement : module natif introuvable ou inutilisable \(/);
});
