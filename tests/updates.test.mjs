/**
 * Service des mises à jour (src/services/updates.js) : ce qu'il décide.
 * Le moteur — réseau, disque, lancement de l'installateur — est ici simulé ;
 * le vrai est éprouvé dans tests/update-engine.test.mjs.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { readText } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { ServiceError } = require('../src/services/hub.js');
const { createUpdatesService, compareVersions, parseManifest, productionFeed, localFeed, setupFileName, MANIFEST_FILE, MANIFEST_SCHEMA, MESSAGES, REPOSITORY, VARIANTS } = require('../src/services/updates.js');

const SHA = 'ab'.repeat(64);
const SIZE = 100 * 1024 * 1024;

/** Description publiée d'une version, telle que le fichier evolve-update.json la contient. */
const published = (version = '0.7.0', changes = {}) => ({
  schema: 1,
  version,
  date: '2026-11-20T10:00:00Z',
  setup: { file: `Evolve-Setup-${version}.exe`, size: SIZE, sha512: SHA },
  ...changes,
});

/** Erreur du moteur, avec son code. */
const failure = (code) => Object.assign(new Error(code), { code });

/**
 * Faux moteur : répond ce qu'on lui a préparé, et note ce qui lui est demandé.
 * `download` ne se termine que lorsque le test le décide.
 */
function fakeEngine({ manifest = { status: 'none' } } = {}) {
  const engine = {
    calls: [],
    manifest,
    /** Fin du téléchargement en cours : `finish(file)` ou `fail(code)`. */
    transfer: null,
    installError: null,
    async readManifest() {
      engine.calls.push('readManifest');
      if (engine.manifest instanceof Error) throw engine.manifest;
      return typeof engine.manifest === 'function' ? engine.manifest() : engine.manifest;
    },
    download(described, { onProgress, signal }) {
      engine.calls.push(`download ${described.version}`);
      return new Promise((resolve, reject) => {
        engine.transfer = {
          progress: onProgress,
          finish: (file = `C:\\Temp\\Evolve-mise-a-jour\\Evolve-Setup-${described.version}.exe`) => resolve({ file }),
          fail: (code) => reject(failure(code)),
        };
        signal.addEventListener('abort', () => reject(failure('cancelled')));
      });
    },
    async install(file, described) {
      engine.calls.push(`install ${file} ${described.version}`);
      if (engine.installError) throw engine.installError;
      return { pid: 4242 };
    },
  };
  return engine;
}

/** Service installé en version 0.6.0, avec son faux moteur et le relevé de ses annonces. */
function installed(options = {}) {
  const engine = options.engine ?? fakeEngine(options);
  const quits = [];
  const events = [];
  const service = createUpdatesService({ variant: 'installed', currentVersion: '0.6.0', engine, quit: () => quits.push('quit'), page: 'https://exemple.invalid/versions', now: () => Date.UTC(2026, 10, 21, 9, 30), ...options });
  service.on((event, state, origin) => events.push({ event, status: state.status, origin, state }));
  return { service, engine, quits, events };
}

/** Attend que `fn` lève une erreur prévue du service, et la renvoie. */
function refusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ServiceError, `erreur imprévue : ${error?.stack}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'la demande aurait dû être refusée' });
}

// ---------------------------------------------------------------------------------
// Numéros de version et description d'une version
// ---------------------------------------------------------------------------------

test('numéros de version : comparés nombre par nombre, jamais comme du texte', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('0.6.0', '0.6.1'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  for (const invalid of ['1.0', '1.0.0.0', 'v1.0.0', '1.0.0-beta', '01.0.0', '1.0.x', '', ' 1.0.0', '1.0.0\n', null, undefined, 100, '1234567.0.0']) {
    assert.throws(() => compareVersions(invalid, '1.0.0'), TypeError, String(invalid));
    assert.throws(() => compareVersions('1.0.0', invalid), TypeError, String(invalid));
  }
});

test('description d’une version : acceptée seulement si elle est complète et cohérente', () => {
  assert.deepEqual(parseManifest(published()), {
    ok: true,
    manifest: { version: '0.7.0', date: '2026-11-20T10:00:00.000Z', file: 'Evolve-Setup-0.7.0.exe', size: SIZE, sha512: SHA },
  });
  // La date est facultative ; illisible, elle est ignorée.
  for (const date of [undefined, null, 'bientôt', 42]) assert.equal(parseManifest(published('0.7.0', { date })).manifest.date, null);
  // Les informations supplémentaires sont ignorées : aucune n'est recopiée.
  assert.deepEqual(Object.keys(parseManifest({ ...published(), url: 'https://ailleurs.invalid/x.exe', notes: 'x' }).manifest), ['version', 'date', 'file', 'size', 'sha512']);

  const refused = (data, detail) => assert.deepEqual(parseManifest(data), { ok: false, code: 'invalid-manifest', detail }, JSON.stringify(data));
  for (const data of [null, undefined, 'texte', 42, [], [published()]]) refused(data, 'la description n’est pas un objet');
  for (const schema of [undefined, null, '1', 0, -1, 1.5]) refused(published('0.7.0', { schema }), 'format non indiqué');
  for (const version of [undefined, 7, '0.7', 'v0.7.0', '0.7.0-rc1', '../0.7.0', '0.7.0/..', '00.7.0']) refused({ ...published(), version }, 'numéro de version invalide');
  for (const setup of [undefined, null, 'Evolve-Setup-0.7.0.exe', []]) refused({ ...published(), setup }, 'installateur non décrit');
  // Le nom de l'installateur ne se choisit pas : il se déduit de la version.
  for (const file of [undefined, 'setup.exe', 'Evolve-Setup-0.8.0.exe', '../Evolve-Setup-0.7.0.exe', 'Evolve-Setup-0.7.0.exe ', 'https://ailleurs.invalid/Evolve-Setup-0.7.0.exe']) {
    refused({ ...published(), setup: { ...published().setup, file } }, 'nom d’installateur inattendu');
  }
  for (const size of [undefined, '104857600', 0, -1, 1024, 1024 * 1024 - 1, 1024 * 1024 * 1024 + 1, 1.5, Number.NaN]) {
    refused({ ...published(), setup: { ...published().setup, size } }, 'taille d’installateur invraisemblable');
  }
  for (const sha512 of [undefined, '', 'ab'.repeat(63), 'AB'.repeat(64), 'zz'.repeat(64), `${'ab'.repeat(64)}0`, 42]) {
    refused({ ...published(), setup: { ...published().setup, sha512 } }, 'empreinte invalide');
  }
  // Un format plus récent : rien n'est deviné.
  assert.deepEqual(parseManifest(published('0.7.0', { schema: MANIFEST_SCHEMA + 1 })), { ok: false, code: 'unsupported-manifest', detail: `format ${MANIFEST_SCHEMA + 1} inconnu de cette version` });
  assert.equal(setupFileName('1.2.3'), 'Evolve-Setup-1.2.3.exe');
  assert.equal(MANIFEST_FILE, 'evolve-update.json');
});

test('adresses de publication : le dépôt d’Evolve, en https ; à l’essai, la machine elle-même et rien d’autre', () => {
  const pkg = JSON.parse(readText('package.json'));
  const feed = productionFeed();
  assert.equal(feed.page, `${pkg.homepage}/releases`);
  assert.equal(`https://github.com/${REPOSITORY.owner}/${REPOSITORY.name}`, pkg.homepage);
  assert.equal(feed.manifestUrl, 'https://github.com/leoblanchart92-hub/Evolve/releases/latest/download/evolve-update.json');
  assert.equal(feed.setupUrl('0.7.0'), 'https://github.com/leoblanchart92-hub/Evolve/releases/download/v0.7.0/Evolve-Setup-0.7.0.exe');
  assert.equal(feed.secure, true);
  assert.equal(feed.kind, 'github');
  // Seul « https » est admis, vers GitHub comme vers les serveurs de fichiers où il redirige un téléchargement.
  for (const address of [feed.manifestUrl, feed.setupUrl('0.7.0'), 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r']) assert.equal(feed.admits(address), true, address);
  for (const address of ['http://github.com/leoblanchart92-hub/Evolve/releases/latest/download/evolve-update.json', 'http://127.0.0.1:8123/evolve-update.json', 'ftp://github.com/x', 'file:///C:/x', 'data:text/plain,x', 'javascript:1', 'github.com', '', null, undefined, 12]) {
    assert.equal(feed.admits(address), false, String(address));
  }
  // Le nom de l'installateur publié est celui que la compilation fabrique.
  assert.equal(pkg.build.nsis.artifactName.replace('${version}', '0.7.0'), setupFileName('0.7.0'));

  const local = localFeed('http://127.0.0.1:8123/essai/');
  const { admits, ...addresses } = local;
  assert.deepEqual({ ...addresses, setupUrl: local.setupUrl('9.9.9') }, { kind: 'local', page: 'http://127.0.0.1:8123/essai', manifestUrl: 'http://127.0.0.1:8123/essai/evolve-update.json', setupUrl: 'http://127.0.0.1:8123/essai/Evolve-Setup-9.9.9.exe', secure: false });
  // À l'essai, seule la machine elle-même est admise : aucune requête ne part vers le réseau.
  for (const address of [local.manifestUrl, local.setupUrl('9.9.9'), 'http://127.0.0.1:1/x', 'http://localhost:8123/y']) assert.equal(admits(address), true, address);
  for (const address of ['https://github.com/x', 'https://127.0.0.1:8123/x', 'http://192.168.1.10:8123/x', 'http://127.0.0.1.exemple.invalid/x', 'http://[::1]:8123/x', 'file:///C:/x', '', null]) assert.equal(admits(address), false, String(address));
  assert.ok(Object.isFrozen(local) && Object.isFrozen(feed));
  assert.equal(localFeed('http://localhost:9000').manifestUrl, 'http://localhost:9000/evolve-update.json');
  // Toute autre adresse est refusée : une option de la ligne de commande ne fait rien installer venu d'ailleurs.
  for (const address of [
    'https://127.0.0.1:8123',
    'http://192.168.1.10:8123',
    'http://exemple.invalid',
    'http://127.0.0.1.exemple.invalid:80',
    'http://localhost.exemple.invalid',
    'http://utilisateur:secret@127.0.0.1:8123',
    'http://127.0.0.1:8123/?x=1',
    'http://127.0.0.1:8123/#x',
    'file:///C:/essai',
    '\\\\serveur\\partage',
    'http://[::1]:8123',
    '',
    null,
    undefined,
    'adresse',
  ]) {
    assert.equal(localFeed(address), null, String(address));
  }
});

// ---------------------------------------------------------------------------------
// Qui se met à jour
// ---------------------------------------------------------------------------------

test('seule la version installée se met à jour : ailleurs, aucune demande n’atteint le moteur', async () => {
  assert.deepEqual(VARIANTS, ['installed', 'portable', 'unpacked', 'development']);
  const cases = [
    { variant: 'portable', currentVersion: '0.6.0' },
    { variant: 'unpacked', currentVersion: '0.6.0' },
    { variant: 'development', currentVersion: '0.6.0' },
    { variant: 'inconnue', currentVersion: '0.6.0' },
    { variant: 'installed', currentVersion: '0.6.0', engine: null },
    { variant: 'installed', currentVersion: 'inconnue' },
    { variant: 'installed', currentVersion: null },
    {},
  ];
  for (const options of cases) {
    const engine = fakeEngine({ manifest: { status: 'ok', data: published() } });
    const service = createUpdatesService({ engine, ...options });
    const state = service.state();
    assert.equal(state.supported, false, JSON.stringify(options));
    assert.equal(state.status, 'idle');
    assert.equal(service.status().state, 'unavailable');
    for (const ask of [() => service.check(), () => service.download(), () => service.install({ confirmed: true })]) {
      const error = await Promise.resolve().then(ask).then(() => null, (reason) => reason);
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, 'unsupported');
    }
    assert.equal(await service.checkAtLaunch(), null);
    assert.deepEqual(service.cancel(), state);
    assert.deepEqual(engine.calls, []);
  }
  // L'exécutable portable le dit en clair : il ne se connecte jamais au réseau.
  const portable = createUpdatesService({ variant: 'portable', currentVersion: '0.6.0', engine: fakeEngine() });
  assert.equal(portable.state().variant, 'portable');
  assert.match(refusal(() => portable.check()).message, /portable ne se met pas à jour de lui-même : il ne se connecte jamais au réseau/);
  assert.equal(createUpdatesService({ variant: 'inconnue' }).state().variant, 'development');
});

// ---------------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------------

test('recherche : aucune version publiée, version identique ou plus ancienne — Evolve est à jour', async () => {
  // Aucune version n'est encore publiée.
  const none = installed();
  const state = await none.service.check();
  assert.deepEqual(state, {
    variant: 'installed',
    supported: true,
    current: '0.6.0',
    status: 'up-to-date',
    available: null,
    latest: null,
    progress: null,
    error: null,
    checkedAt: '2026-11-21T09:30:00.000Z',
    automatic: true,
    updated: false,
    page: 'https://exemple.invalid/versions',
  });
  assert.deepEqual(none.events.map((item) => item.status), ['checking', 'up-to-date']);

  // La version publiée est celle en cours.
  const same = installed({ manifest: { status: 'ok', data: published('0.6.0') } });
  assert.deepEqual([(await same.service.check()).status, same.service.state().latest, same.service.state().available], ['up-to-date', '0.6.0', null]);

  // La version publiée est plus ancienne : jamais de retour en arrière.
  for (const older of ['0.5.9', '0.5.0', '0.0.1']) {
    const { service } = installed({ manifest: { status: 'ok', data: published(older) } });
    const after = await service.check();
    assert.deepEqual([after.status, after.latest, after.available], ['up-to-date', older, null], older);
    assert.equal(refusal(() => service.download()).code, 'nothing-to-download');
  }
});

test('recherche : une version plus récente est proposée, avec sa taille et sa date — rien n’est téléchargé', async () => {
  for (const newer of ['0.6.1', '0.7.0', '0.10.0', '1.0.0']) {
    const { service, engine, events } = installed({ manifest: { status: 'ok', data: published(newer) } });
    const state = await service.check();
    assert.equal(state.status, 'available', newer);
    assert.deepEqual(state.available, { version: newer, size: SIZE, date: '2026-11-20T10:00:00.000Z' });
    assert.equal(state.latest, newer);
    assert.equal(state.error, null);
    // Une seule lecture de la description : aucun téléchargement n'a commencé.
    assert.deepEqual(engine.calls, ['readManifest']);
    assert.deepEqual(events.map((item) => item.status), ['checking', 'available']);
    assert.deepEqual(service.status(), {
      state: 'available',
      variant: 'installed',
      supported: true,
      current: '0.6.0',
      status: 'available',
      latest: newer,
      available: newer,
      ready: false,
      automatic: true,
      checkedAt: '2026-11-21T09:30:00.000Z',
      error: null,
      page: 'https://exemple.invalid/versions',
    });
  }
});

test('recherche : chaque incident est nommé, et ce qui était su avant elle le reste', async () => {
  const cases = [
    [failure('offline'), 'offline'],
    [failure('unreachable'), 'unreachable'],
    [failure('invalid-manifest'), 'invalid-manifest'],
    [{ status: 'ok', data: { schema: 1 } }, 'invalid-manifest'],
    [{ status: 'ok', data: null }, 'invalid-manifest'],
    [{ status: 'ok', data: published('0.7.0', { schema: 2 }) }, 'unsupported-manifest'],
    [null, 'invalid-manifest'],
    [{}, 'invalid-manifest'],
    [new Error('panne imprévue'), 'failed'],
    [failure('code-inconnu'), 'failed'],
  ];
  for (const [manifest, code] of cases) {
    const { service, events } = installed({ manifest });
    const state = await service.check();
    assert.equal(state.status, 'idle', code);
    assert.deepEqual(state.error, { code, message: MESSAGES[code] });
    assert.equal(state.available, null);
    assert.deepEqual(events.map((item) => item.status), ['checking', 'idle']);
  }
  // Le message ne contient jamais le détail technique de la panne.
  for (const message of Object.values(MESSAGES)) assert.doesNotMatch(message, /undefined|null|Error|\{|\}/);

  // Une version déjà proposée le reste si la recherche suivante échoue.
  const { service, engine } = installed({ manifest: { status: 'ok', data: published('0.7.0') } });
  await service.check();
  engine.manifest = failure('offline');
  const after = await service.check();
  assert.equal(after.status, 'available');
  assert.equal(after.available.version, '0.7.0');
  assert.equal(after.error.code, 'offline');
  // Une recherche réussie efface l'incident.
  engine.manifest = { status: 'ok', data: published('0.7.0') };
  assert.equal((await service.check()).error, null);
});

test('recherche : une seule à la fois ; au lancement, seulement si le réglage le demande', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { service, engine } = installed({ manifest: () => gate.then(() => ({ status: 'ok', data: published('0.7.0') })) });
  const first = service.check();
  const second = service.check();
  assert.equal(first, second, 'la même recherche');
  assert.equal(service.state().status, 'checking');
  release();
  assert.equal((await first).status, 'available');
  assert.deepEqual(engine.calls, ['readManifest']);

  // Réglage désactivé : aucune recherche au lancement — la recherche à la demande reste possible.
  let automatic = false;
  const manual = installed({ manifest: { status: 'ok', data: published('0.7.0') }, automatic: () => automatic });
  assert.equal(manual.service.state().automatic, false);
  assert.equal(await manual.service.checkAtLaunch(), null);
  assert.deepEqual(manual.engine.calls, []);
  assert.equal((await manual.service.check()).status, 'available');
  // Réglage activé : la recherche a lieu ; un échec ne lève aucune exception.
  automatic = true;
  assert.equal(manual.service.state().automatic, true);
  manual.engine.manifest = failure('offline');
  const launched = await manual.service.checkAtLaunch();
  assert.equal(launched.error.code, 'offline');
  // Un réglage illisible vaut « non ».
  const broken = installed({
    automatic: () => {
      throw new Error('réglages indisponibles');
    },
  });
  assert.equal(broken.service.state().automatic, false);
  assert.equal(await broken.service.checkAtLaunch(), null);
});

// ---------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------

test('téléchargement : seulement à la demande ; progression annoncée, puis « prêt » une fois le fichier vérifié', async () => {
  const { service, engine, events } = installed({ manifest: { status: 'ok', data: published('0.7.0') } });
  // Rien à télécharger tant qu'aucune version n'est proposée.
  assert.equal(refusal(() => service.download()).code, 'nothing-to-download');
  await service.check();
  events.length = 0;

  const started = service.download();
  assert.equal(started.status, 'downloading');
  assert.deepEqual(started.progress, { received: 0, total: SIZE });
  // Une seconde demande ne lance pas un second téléchargement.
  assert.equal(service.download().status, 'downloading');
  await Promise.resolve();
  assert.deepEqual(engine.calls, ['readManifest', 'download 0.7.0']);
  // Une recherche est refusée pendant le téléchargement.
  assert.equal(refusal(() => service.check()).code, 'busy');

  // Progression : au plus une annonce par centième de la taille.
  for (let step = 1; step <= 1000; step += 1) engine.transfer.progress((SIZE / 1000) * step);
  const announced = events.filter((item) => item.status === 'downloading');
  assert.ok(announced.length >= 90 && announced.length <= 102, `annonces : ${announced.length}`);
  assert.deepEqual(announced.at(-1).state.progress, { received: SIZE, total: SIZE });
  // Une progression aberrante est bornée ou ignorée.
  engine.transfer.progress(SIZE * 3);
  assert.deepEqual(service.state().progress, { received: SIZE, total: SIZE });
  engine.transfer.progress(Number.NaN);
  engine.transfer.progress(-5);
  assert.equal(service.state().progress.received, 0);

  engine.transfer.finish();
  await service.settled();
  const state = service.state();
  assert.equal(state.status, 'ready');
  assert.equal(state.progress, null);
  assert.equal(state.error, null);
  assert.equal(service.status().ready, true);
  assert.equal(events.at(-1).status, 'ready');
  // Déjà prêt : rien n'est téléchargé une seconde fois.
  assert.equal(service.download().status, 'ready');
  assert.equal(engine.calls.filter((call) => call.startsWith('download')).length, 1);
});

test('téléchargement : un échec est nommé, une interruption demandée n’en est pas un', async () => {
  for (const [code, expected] of [['download-failed', 'download-failed'], ['checksum', 'checksum'], ['disk', 'disk'], ['inconnu', 'failed'], [undefined, 'download-failed']]) {
    const { service, engine } = installed({ manifest: { status: 'ok', data: published('0.7.0') } });
    await service.check();
    service.download();
    await Promise.resolve();
    engine.transfer.fail(code);
    await service.settled();
    const state = service.state();
    assert.equal(state.status, 'available', String(code));
    assert.deepEqual(state.error, { code: expected, message: MESSAGES[expected] });
    assert.equal(state.progress, null);
    assert.equal(service.status().ready, false);
    // Un nouvel essai est possible.
    assert.equal(service.download().status, 'downloading');
    assert.equal(service.state().error, null);
  }

  // Un moteur qui ne rend aucun fichier : rien n'est tenu pour prêt.
  const empty = installed({ manifest: { status: 'ok', data: published('0.7.0') } });
  await empty.service.check();
  empty.service.download();
  await Promise.resolve();
  empty.engine.transfer.finish('');
  await empty.service.settled();
  assert.deepEqual([empty.service.state().status, empty.service.state().error.code], ['available', 'download-failed']);

  // Interruption à la demande : retour à « disponible », sans incident.
  const { service, events } = installed({ manifest: { status: 'ok', data: published('0.7.0') } });
  await service.check();
  // Sans téléchargement en cours, « annuler » est sans effet.
  assert.equal(service.cancel().status, 'available');
  service.download();
  await Promise.resolve();
  service.cancel();
  await service.settled();
  assert.deepEqual([service.state().status, service.state().error, service.state().progress], ['available', null, null]);
  assert.equal(events.at(-1).status, 'available');
});

test('après un téléchargement : une nouvelle recherche garde le fichier prêt s’il s’agit du même, et l’écarte sinon', async () => {
  const { service, engine } = installed({ manifest: { status: 'ok', data: published('0.7.0') } });
  await service.check();
  service.download();
  await Promise.resolve();
  engine.transfer.finish();
  await service.settled();
  // Même version, même fichier : toujours prêt.
  assert.equal((await service.check()).status, 'ready');
  // La recherche échoue : toujours prêt, l'incident est seulement signalé.
  engine.manifest = failure('offline');
  assert.deepEqual([(await service.check()).status, service.state().error.code], ['ready', 'offline']);
  // Même version, mais un autre fichier a été publié : il faut le télécharger de nouveau.
  engine.manifest = { status: 'ok', data: published('0.7.0', { setup: { file: 'Evolve-Setup-0.7.0.exe', size: SIZE, sha512: 'cd'.repeat(64) } }) };
  assert.equal((await service.check()).status, 'available');
  assert.equal(service.status().ready, false);
  const refused = await service.install({ confirmed: true }).then(() => null, (reason) => reason);
  assert.equal(refused.code, 'nothing-to-install');
});

// ---------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------

/** Service dont la version 0.7.0 est téléchargée et vérifiée. */
async function ready(options = {}) {
  const context = installed({ manifest: { status: 'ok', data: published('0.7.0') }, ...options });
  await context.service.check();
  context.service.download();
  await Promise.resolve();
  context.engine.transfer.finish('C:\\Temp\\Evolve-mise-a-jour\\Evolve-Setup-0.7.0.exe');
  await context.service.settled();
  context.events.length = 0;
  return context;
}

test('installation : exige un fichier prêt et une confirmation ; l’installateur lancé, Evolve se ferme', async () => {
  // Rien de prêt : refus, à chaque étape qui précède.
  const early = installed({ manifest: { status: 'ok', data: published('0.7.0') } });
  for (const step of [() => {}, () => early.service.check(), () => early.service.download()]) {
    await step();
    const error = await early.service.install({ confirmed: true }).then(() => null, (reason) => reason);
    assert.equal(error.code, 'nothing-to-install');
  }
  assert.deepEqual(early.quits, []);

  const { service, engine, quits, events } = await ready();
  // Sans confirmation explicite : refus, rien n'est lancé.
  for (const choices of [undefined, null, {}, { confirmed: false }, { confirmed: 'oui' }, { confirmed: 1 }, true]) {
    const error = await service.install(choices).then(() => null, (reason) => reason);
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, 'confirmation-required', JSON.stringify(choices));
  }
  assert.equal(engine.calls.filter((call) => call.startsWith('install')).length, 0);
  assert.deepEqual(quits, []);
  assert.equal(service.state().status, 'ready');

  assert.equal(await service.install({ confirmed: true }), true);
  assert.deepEqual(engine.calls.at(-1), 'install C:\\Temp\\Evolve-mise-a-jour\\Evolve-Setup-0.7.0.exe 0.7.0');
  // Evolve se ferme après le lancement de l'installateur, une seule fois.
  assert.deepEqual(quits, ['quit']);
  assert.deepEqual(events.map((item) => item.status), ['installing']);
  assert.equal(service.state().status, 'installing');
  // Une seconde demande ne lance pas un second installateur ; plus rien d'autre n'est accepté.
  assert.equal(await service.install({ confirmed: true }), true);
  assert.equal(engine.calls.filter((call) => call.startsWith('install')).length, 1);
  assert.equal(refusal(() => service.check()).code, 'busy');
});

test('installation : refusée pendant une opération sur les fichiers ; un lancement impossible laisse Evolve ouvert', async () => {
  let copying = true;
  const { service, engine, quits } = await ready({ busy: () => copying });
  const error = await service.install({ confirmed: true }).then(() => null, (reason) => reason);
  assert.equal(error.code, 'busy');
  assert.match(error.message, /opération sur des fichiers est en cours/);
  assert.equal(engine.calls.filter((call) => call.startsWith('install')).length, 0);
  assert.equal(service.state().status, 'ready');
  copying = false;

  // L'installateur ne peut pas être lancé : l'état « prêt » est conservé, Evolve n'est pas fermé.
  for (const [thrown, code] of [[failure('install-failed'), 'install-failed'], [failure('checksum'), 'checksum'], [new Error('accès refusé'), 'install-failed']]) {
    engine.installError = thrown;
    const failed = await service.install({ confirmed: true }).then(() => null, (reason) => reason);
    assert.ok(failed instanceof ServiceError);
    assert.equal(failed.code, code);
    assert.equal(failed.message, MESSAGES[code]);
    assert.deepEqual([service.state().status, service.state().error.code], ['ready', code]);
    assert.deepEqual(quits, []);
  }
  engine.installError = null;
  assert.equal(await service.install({ confirmed: true }), true);
  assert.deepEqual(quits, ['quit']);

  // Une fermeture impossible ne fait pas échouer la demande : l'installateur est déjà lancé.
  const stuck = await ready({
    quit: () => {
      throw new Error('fermeture impossible');
    },
  });
  assert.equal(await stuck.service.install({ confirmed: true }), true);
});

// ---------------------------------------------------------------------------------
// Annonces
// ---------------------------------------------------------------------------------

test('annonces : l’état complet, l’origine de la demande, et un abonné en panne n’arrête rien', async () => {
  const logs = [];
  const { service, events } = installed({ manifest: { status: 'ok', data: published('0.7.0') }, log: (message) => logs.push(message), updated: true });
  assert.equal(service.state().updated, true);
  service.on(() => {
    throw new Error('abonné en panne');
  });
  const stop = service.on(() => events.push('second'));
  await service.check({ origin: 'window' });
  assert.deepEqual(events.filter((item) => item !== 'second').map((item) => [item.event, item.status, item.origin]), [['changed', 'checking', 'window'], ['changed', 'available', 'window']]);
  assert.equal(events.filter((item) => item === 'second').length, 2);
  assert.equal(logs.filter((message) => /abonné en erreur : abonné en panne/.test(message)).length, 2);
  // Chaque annonce est une copie : la modifier ne change rien au service.
  const announced = events.filter((item) => item !== 'second');
  announced[0].state.status = 'modifié';
  announced[1].state.available.version = '9.9.9';
  assert.equal(service.state().available.version, '0.7.0');
  assert.equal(service.state().status, 'available');
  stop();
  events.length = 0;
  service.refresh();
  assert.deepEqual(events.map((item) => item.status), ['available']);
  // Arrêt de l'application : un téléchargement en cours est interrompu.
  service.download();
  await Promise.resolve();
  service.dispose();
  await service.settled();
  assert.equal(service.state().status, 'available');
});
