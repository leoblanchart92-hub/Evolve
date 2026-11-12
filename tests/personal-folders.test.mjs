/**
 * Emplacement des dossiers personnels (src/main/personal-folders.js) : il est
 * demandé au moteur sans que rien ne soit jamais créé sur le disque — un
 * dossier absent, Documents compris, reste absent.
 *
 * Le moteur est imité par tests/fixtures/fake-electron.cjs (createEnginePaths),
 * défaut compris : il crée le dossier Documents absent dès que le système lui
 * en donne le chemin sans en vérifier l'existence (tout système sauf Windows).
 * Les dossiers sont de vrais dossiers, dans un dossier temporaire.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const { personalFolders, engineOnlyReads, PERSONAL_FOLDERS, CREATED_WHEN_MISSING } = require('../src/main/personal-folders.js');
const { createFilesService, PLACE_IDS, READ_ONLY_CALLS } = require('../src/services/files.js');
const { createEnginePaths, PERSONAL_FOLDERS: FOLDER_NAMES } = require('./fixtures/fake-electron.cjs');
const { createFakeFs, file } = require('./fixtures/fake-fs.cjs');

const workDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'evolve-dossiers-')));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Systèmes imités : Windows (le système vérifie l'existence du dossier), et deux autres. */
const PLATFORMS = ['win32', 'linux', 'darwin'];
const ALL = Object.keys(FOLDER_NAMES);

let sequence = 0;

/**
 * Faux compte d'utilisateur, relié à un moteur imité.
 * @param {object} options
 * @param {string} options.platform       système imité
 * @param {string[]} [options.present]    dossiers personnels présents sur le disque
 * @param {boolean} [options.profile]     créer le dossier du compte lui-même
 */
function account({ platform, present = ALL, profile: withProfile = true }) {
  const base = path.join(workDir, `compte-${(sequence += 1)}`);
  const profile = path.join(base, 'Léo');
  mkdirSync(base);
  if (withProfile) {
    mkdirSync(profile);
    for (const id of present) mkdirSync(path.join(profile, FOLDER_NAMES[id]));
    writeFileSync(path.join(profile, 'NTUSER.DAT'), 'profil');
  }
  const state = { pathRequests: [], unknownFolders: [], movedFolders: {}, createdByEngine: [] };
  const getPath = createEnginePaths({ profile, platform, state });
  return {
    base,
    profile,
    state,
    getPath,
    folder: (id) => path.join(profile, FOLDER_NAMES[id]),
    locate: (known) => personalFolders({ getPath, platform, known }),
  };
}

/** État complet d'un dossier : chaque élément, sa nature et sa date de modification. */
function snapshot(folder) {
  const lines = [];
  (function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, item.name);
      lines.push(`${path.relative(folder, full)} ${item.isDirectory() ? 'dossier' : 'fichier'} ${Math.round(statSync(full).mtimeMs)}`);
      if (item.isDirectory()) walk(full);
    }
  })(folder);
  return lines;
}

// ---------------------------------------------------------------------------------
// Le défaut du moteur, tel qu'il est imité
// ---------------------------------------------------------------------------------

test('le moteur imité reproduit le défaut : hors de Windows, lui demander « Documents » crée le dossier absent', () => {
  for (const platform of ['linux', 'darwin']) {
    const { getPath, folder, state } = account({ platform, present: ['desktop'] });
    assert.equal(getPath('documents'), folder('documents'));
    assert.equal(existsSync(folder('documents')), true, `${platform} : le dossier a été créé par la simple demande`);
    assert.deepEqual(state.createdByEngine, [folder('documents')]);
    // Les autres dossiers ne sont jamais créés par le moteur.
    for (const id of ['downloads', 'pictures', 'music', 'videos']) {
      assert.equal(getPath(id), folder(id));
      assert.equal(existsSync(folder(id)), false, id);
    }
  }

  // Sous Windows, le système vérifie que le dossier existe : absent, la demande échoue, et rien n'est créé.
  const windows = account({ platform: 'win32', present: ['desktop'] });
  for (const id of ['documents', 'downloads', 'pictures', 'music', 'videos']) {
    assert.throws(() => windows.getPath(id), new RegExp(`^Error: Failed to get '${id}' path$`));
    assert.equal(existsSync(windows.folder(id)), false, id);
  }
  assert.deepEqual(windows.state.createdByEngine, []);
});

// ---------------------------------------------------------------------------------
// Un dossier absent reste absent
// ---------------------------------------------------------------------------------

test('dossier Documents absent : il reste absent après la recherche des dossiers personnels, sur chaque système', () => {
  for (const platform of PLATFORMS) {
    const { locate, folder, profile, state } = account({ platform, present: ALL.filter((id) => id !== 'documents') });
    const before = snapshot(profile);

    const first = locate();
    const second = locate(); // une seconde recherche (nouvelle session) ne crée rien non plus

    assert.equal(existsSync(folder('documents')), false, `${platform} : le dossier Documents est toujours absent`);
    assert.deepEqual(snapshot(profile), before, `${platform} : rien n'a changé dans le dossier du compte`);
    assert.deepEqual(state.createdByEngine, [], `${platform} : le moteur n'a rien créé`);
    assert.deepEqual(first, second);

    if (platform === 'win32') {
      // Windows répond lui-même que le dossier n'existe pas.
      assert.equal(first.documents, null);
      assert.equal(state.pathRequests.filter((name) => name === 'documents').length, 2, 'une demande par recherche');
    } else {
      // La question n'est pas posée au moteur, qui créerait le dossier.
      assert.equal(state.pathRequests.includes('documents'), false, `${platform} : aucune demande « documents » au moteur`);
      assert.equal(first.documents, folder('documents'), 'emplacement habituel, désigné sans le moteur');
    }
    // Les cinq autres sont trouvés.
    for (const id of ALL.filter((name) => name !== 'documents')) assert.equal(first[id], folder(id), `${platform} ${id}`);
  }
});

test('chaque dossier personnel absent reste absent : Bureau, Documents, Téléchargements, Images, Musique, Vidéos', () => {
  for (const platform of PLATFORMS) {
    for (const missing of ALL) {
      const { locate, folder, profile, state } = account({ platform, present: ALL.filter((id) => id !== missing) });
      const before = snapshot(profile);
      const found = locate();
      assert.equal(existsSync(folder(missing)), false, `${platform} : ${missing} toujours absent`);
      assert.deepEqual(snapshot(profile), before, `${platform} ${missing}`);
      assert.deepEqual(state.createdByEngine, []);
      for (const id of ALL.filter((name) => name !== missing)) assert.equal(found[id], folder(id), `${platform} : ${id} trouvé`);
    }
  }
});

test('aucun dossier personnel, ou pas de dossier de compte du tout : rien n’apparaît', () => {
  for (const platform of PLATFORMS) {
    const empty = account({ platform, present: [] });
    const before = snapshot(empty.base);
    empty.locate();
    assert.deepEqual(snapshot(empty.base), before, `${platform} : compte sans dossier personnel`);
    assert.deepEqual(readdirSync(empty.profile), ['NTUSER.DAT']);

    const none = account({ platform, profile: false });
    none.locate();
    assert.deepEqual(readdirSync(none.base), [], `${platform} : le dossier du compte lui-même n'est pas créé`);
    assert.deepEqual(none.state.createdByEngine, []);
  }
});

test('Windows, Téléchargements absent : le moteur désigne « Downloads » dans Documents, sans le créer', () => {
  const { locate, folder, profile } = account({ platform: 'win32', present: ALL.filter((id) => id !== 'downloads') });
  const before = snapshot(profile);
  const found = locate();
  assert.equal(found.downloads, path.join(folder('documents'), 'Downloads'));
  assert.equal(existsSync(found.downloads), false);
  assert.equal(existsSync(folder('downloads')), false);
  assert.deepEqual(snapshot(profile), before);

  // Documents absent lui aussi : aucun emplacement, et toujours rien de créé.
  const both = account({ platform: 'win32', present: ['desktop', 'pictures', 'music', 'videos'] });
  const after = both.locate();
  assert.deepEqual([after.documents, after.downloads], [null, null]);
  assert.deepEqual(readdirSync(both.profile).sort(), ['Desktop', 'Music', 'NTUSER.DAT', 'Pictures', 'Videos']);
});

// ---------------------------------------------------------------------------------
// Dossiers présents
// ---------------------------------------------------------------------------------

test('dossiers présents : les six emplacements, dans l’ordre du service de fichiers, une demande par dossier', () => {
  assert.deepEqual(PERSONAL_FOLDERS, PLACE_IDS);
  assert.ok(Object.isFrozen(PERSONAL_FOLDERS) && Object.isFrozen(CREATED_WHEN_MISSING));

  for (const platform of PLATFORMS) {
    const { locate, folder, profile, state } = account({ platform });
    const before = snapshot(profile);
    const found = locate();
    assert.deepEqual(Object.keys(found), ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']);
    for (const id of ALL) assert.equal(found[id], folder(id), `${platform} ${id}`);
    assert.deepEqual(snapshot(profile), before);
    assert.deepEqual(
      state.pathRequests,
      platform === 'win32' ? ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'] : ['desktop', 'home', 'downloads', 'pictures', 'music', 'videos'],
      platform,
    );
  }
});

test('dossier déplacé (OneDrive, autre disque) : trouvé là où le système l’indique', () => {
  const windows = account({ platform: 'win32' });
  const moved = path.join(windows.base, 'OneDrive', 'Documents');
  mkdirSync(moved, { recursive: true });
  windows.state.movedFolders.documents = moved;
  windows.state.movedFolders.pictures = path.join(windows.base, 'OneDrive', 'Images');
  mkdirSync(windows.state.movedFolders.pictures);
  const found = windows.locate();
  assert.equal(found.documents, moved, 'le dossier Documents déplacé, et non celui resté dans le profil');
  assert.equal(found.pictures, windows.state.movedFolders.pictures);
  assert.equal(found.desktop, windows.folder('desktop'));

  // Déplacé puis disparu (disque débranché, dossier supprimé) : introuvable, et rien n'est créé à sa place.
  rmSync(moved, { recursive: true });
  assert.equal(windows.locate().documents, null);
  assert.equal(existsSync(moved), false);
  assert.deepEqual(windows.state.createdByEngine, []);
});

// ---------------------------------------------------------------------------------
// Réponses inutilisables
// ---------------------------------------------------------------------------------

test('dossier inconnu du système, ou réponse inutilisable du moteur : introuvable, jamais d’exception', () => {
  for (const platform of PLATFORMS) {
    const { locate, state, folder } = account({ platform });
    state.unknownFolders.push('music', 'desktop');
    const found = locate();
    assert.deepEqual([found.music, found.desktop], [null, null], platform);
    assert.equal(found.pictures, folder('pictures'));
  }

  for (const answer of ['', 42, null, undefined, {}, [], true]) {
    const found = personalFolders({ getPath: () => answer, platform: 'win32' });
    assert.deepEqual(found, { desktop: null, documents: null, downloads: null, pictures: null, music: null, videos: null }, String(answer));
  }
  const failing = personalFolders({
    getPath: () => {
      throw 'panne'; // eslint-disable-line no-throw-literal
    },
    platform: 'linux',
  });
  assert.deepEqual(Object.values(failing), [null, null, null, null, null, null]);
});

test('hors de Windows, sans dossier de compte utilisable, « Documents » est introuvable', () => {
  const answers = {
    relatif: 'compte/sans/racine',
    vide: '',
    absent: undefined,
  };
  for (const [label, home] of Object.entries(answers)) {
    const found = personalFolders({ getPath: (name) => (name === 'home' ? home : path.join(workDir, name)), platform: 'linux' });
    assert.equal(found.documents, null, label);
    assert.equal(found.music, path.join(workDir, 'music'));
  }
});

test('le moteur n’est interrogé que là où il se contente de lire', () => {
  for (const id of ALL) assert.equal(engineOnlyReads(id, 'win32'), true, `Windows vérifie l'existence de ${id}`);
  for (const platform of ['linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android', '']) {
    assert.equal(engineOnlyReads('documents', platform), false, `${platform} : le moteur créerait le dossier`);
    for (const id of ALL.filter((name) => name !== 'documents')) assert.equal(engineOnlyReads(id, platform), true, `${platform} ${id}`);
  }
  assert.deepEqual(CREATED_WHEN_MISSING, { documents: 'Documents' });
  // Un nom qui n'est pas un dossier personnel n'est pas confondu avec « Documents ».
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(engineOnlyReads(name, 'linux'), true, name);
});

// ---------------------------------------------------------------------------------
// Avec le service de fichiers
// ---------------------------------------------------------------------------------

test('avec le service de fichiers : Documents absent est signalé indisponible, son ouverture est refusée, et rien n’est créé', async () => {
  for (const platform of PLATFORMS) {
    const { locate, folder, profile, state } = account({ platform, present: ALL.filter((id) => id !== 'documents') });
    const before = snapshot(profile);
    const service = createFilesService({ places: (known) => locate(known) });

    const { places } = await service.places();
    assert.deepEqual(places.find((place) => place.id === 'documents'), { id: 'documents', path: null, available: false }, platform);
    assert.equal(places.filter((place) => place.available).length, 5);

    // Ouvrir le dossier là où il devrait être : refus, sans création.
    for (const target of [folder('documents'), path.join(folder('documents'), 'Sous-dossier')]) {
      await assert.rejects(service.list(target), (error) => ['outside-allowed', 'not-found'].includes(error.code), `${platform} ${target}`);
    }
    // Nouvelles recherches (actualisation) : toujours indisponible, toujours absent.
    const first = state.pathRequests.length;
    assert.equal(first, 6, 'six demandes à la première recherche');
    assert.equal((await service.places()).places.find((place) => place.id === 'documents').available, false);
    assert.equal((await service.places()).places.find((place) => place.id === 'documents').available, false);

    // Un emplacement obtenu n'est jamais redemandé. Sous Windows, seul « Documents », resté introuvable,
    // l'est à chaque recherche — sans effet ; ailleurs, le moteur n'est plus sollicité du tout.
    assert.deepEqual(state.pathRequests.slice(first), platform === 'win32' ? ['documents', 'documents'] : [], platform);
    assert.equal(state.pathRequests.includes('documents'), platform === 'win32', platform);
    assert.equal(existsSync(folder('documents')), false, `${platform} : le dossier Documents est toujours absent`);
    assert.deepEqual(snapshot(profile), before, platform);
    assert.deepEqual(state.createdByEngine, []);
  }
});

test('dossier Documents absent puis revenu : retrouvé à la recherche suivante, sur chaque système — et jamais créé par le moteur', async () => {
  for (const platform of PLATFORMS) {
    const { locate, folder, profile, state } = account({ platform, present: ALL.filter((id) => id !== 'documents') });
    const service = createFilesService({ places: (known) => locate(known) });
    const documents = async () => (await service.places()).places.find((place) => place.id === 'documents');

    assert.deepEqual(await documents(), { id: 'documents', path: null, available: false }, platform);
    assert.equal(existsSync(folder('documents')), false);

    // L'utilisateur remet son dossier en place.
    mkdirSync(folder('documents'));
    assert.deepEqual(await documents(), { id: 'documents', path: folder('documents'), available: true }, platform);
    assert.deepEqual((await service.list(folder('documents'))).entries, []);
    // Une fois situé, il n'est plus demandé au moteur.
    const asked = state.pathRequests.length;
    await documents();
    assert.equal(state.pathRequests.length, asked, platform);

    // Retiré de nouveau : signalé absent — et toujours pas recréé.
    rmSync(folder('documents'), { recursive: true });
    assert.deepEqual(await documents(), { id: 'documents', path: null, available: false }, platform);
    assert.equal(existsSync(folder('documents')), false, platform);
    assert.deepEqual(state.createdByEngine, [], platform);
    assert.deepEqual(readdirSync(profile).sort(), ['Desktop', 'Downloads', 'Music', 'NTUSER.DAT', 'Pictures', 'Videos']);
  }
});

test('emplacements déjà obtenus : le moteur n’est interrogé que sur les autres', () => {
  for (const platform of PLATFORMS) {
    const { locate, folder, state } = account({ platform });
    const all = locate();
    state.pathRequests.length = 0;

    // Tout est connu : aucune demande.
    assert.deepEqual(locate(all), all);
    assert.deepEqual(state.pathRequests, [], platform);

    // Deux dossiers restent à situer : eux seuls sont demandés.
    assert.deepEqual(locate({ ...all, music: null, videos: '' }), all);
    assert.deepEqual(state.pathRequests, ['music', 'videos'], platform);

    // Valeurs inutilisables : traitées comme inconnues, jamais reprises telles quelles.
    state.pathRequests.length = 0;
    const repaired = locate({ desktop: 42, documents: undefined, downloads: {}, pictures: [], music: true, videos: null });
    assert.deepEqual(repaired, all, platform);
    assert.equal(state.pathRequests.length, 6);
    // Un emplacement connu est repris sans vérification ni demande : c'est le service de fichiers qui contrôle son existence.
    assert.equal(locate({ ...all, pictures: folder('music') }).pictures, folder('music'));
  }
  // Sans emplacement connu, ou avec une valeur qui n'en est pas : comme une première recherche.
  for (const known of [undefined, null, {}, 'texte', 7]) {
    const { locate, state } = account({ platform: 'win32' });
    locate(known);
    assert.deepEqual(state.pathRequests, ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'], String(known));
  }
});

test('PC sous Windows sans dossier Documents (disque simulé) : signalé introuvable, et le disque n’est que lu', async () => {
  // Disque d'un PC dont le compte n'a ni Documents ni Vidéos. Ce faux disque n'offre aucune fonction d'écriture.
  const PROFILE = 'C:\\Users\\Léo';
  const disk = createFakeFs({
    platform: 'win32',
    drives: {
      'C:\\': {
        totalBytes: 512e9,
        freeBytes: 128e9,
        tree: { Users: { Léo: { Desktop: { 'Notes.txt': file(7) }, Downloads: {}, Music: {}, Pictures: {} } }, Windows: {} },
      },
    },
  });
  // Le moteur, sous Windows : la demande d'un dossier absent échoue.
  const existing = { desktop: 'Desktop', downloads: 'Downloads', music: 'Music', pictures: 'Pictures' };
  const asked = [];
  const getPath = (name) => {
    asked.push(name);
    if (!Object.hasOwn(existing, name)) throw new Error(`Failed to get '${name}' path`);
    return `${PROFILE}\\${existing[name]}`;
  };
  const service = createFilesService({
    platform: 'win32',
    fs: disk.fs,
    env: { SystemDrive: 'C:' },
    places: (known) => personalFolders({ getPath, platform: 'win32', known }),
    drives: 'auto',
    limits: { probeMs: 200 },
  });

  const { places } = await service.places();
  assert.deepEqual(asked, ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']);
  assert.deepEqual(places.map((place) => [place.id, place.available]), [
    ['desktop', true],
    ['documents', false],
    ['downloads', true],
    ['pictures', true],
    ['music', true],
    ['videos', false],
  ]);
  assert.deepEqual(places.find((place) => place.id === 'documents'), { id: 'documents', path: null, available: false });

  // Ouvrir le dossier à son emplacement habituel : « introuvable », sous toutes ses écritures.
  for (const target of [`${PROFILE}\\Documents`, `${PROFILE}\\Documents\\`, `${PROFILE}\\documents`, `${PROFILE}\\Documents\\Projets`, `${PROFILE}\\Videos`]) {
    await assert.rejects(service.list(target), (error) => error.code === 'not-found', target);
  }
  // Les autres dossiers se consultent normalement.
  const desktop = await service.list(`${PROFILE}\\Desktop`);
  assert.deepEqual(desktop.entries.map((item) => item.name), ['Notes.txt']);
  await service.places();

  // Seules les quatre fonctions de lecture ont été employées — aucune autre n'a même été approchée.
  assert.deepEqual([...disk.touched].sort(), [...READ_ONLY_CALLS].sort());
  assert.deepEqual([...new Set(disk.calls.map(([name]) => name))].sort(), [...READ_ONLY_CALLS].sort());
  // À la seconde recherche, le moteur n'a été interrogé que sur les deux dossiers restés introuvables.
  assert.deepEqual(asked.slice(6), ['documents', 'videos']);
});

