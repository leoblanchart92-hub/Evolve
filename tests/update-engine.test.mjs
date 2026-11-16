/**
 * Moteur des mises à jour (src/main/update-engine.js), exécuté contre un vrai
 * serveur local et un vrai dossier : lecture de la description d'une version,
 * téléchargement vérifié de son installateur, lancement de celui-ci.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { readText, stripComments } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createUpdateEngine, DOWNLOAD_DIR, INSTALL_ARGUMENTS, DEFAULT_TIMINGS, MANIFEST_LIMIT } = require('../src/main/update-engine.js');
const { compareVersions, localFeed, productionFeed } = require('../src/services/updates.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-maj-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Contenu d'un faux installateur : 300 Ko, différents d'une version à l'autre. */
const setupBytes = (version) => Buffer.alloc(300 * 1024, `installateur ${version} `);
const digest = (bytes) => createHash('sha512').update(bytes).digest('hex');
/** Description contrôlée d'une version, telle que le service la remet au moteur. */
const manifestOf = (version, bytes = setupBytes(version)) => ({ version, date: null, file: `Evolve-Setup-${version}.exe`, size: bytes.length, sha512: digest(bytes) });

/** Réponses du serveur, par chemin : fonction `(requête, réponse)`. Les tests en ajoutent. */
const routes = new Map();
/** Chemins demandés, dans l'ordre. */
const hits = [];
let server;
let base;

before(async () => {
  server = createServer((request, response) => {
    hits.push(request.url);
    const route = routes.get(request.url);
    if (!route) {
      response.writeHead(404).end('introuvable');
      return;
    }
    route(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
}));

/** Sert un texte ou des octets, avec leur taille. */
const serve = (url, body, { status = 200, type = 'application/octet-stream' } = {}) =>
  routes.set(url, (_request, response) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    response.writeHead(status, { 'content-type': type, 'content-length': bytes.length }).end(bytes);
  });

let counter = 0;
/** Moteur relié au serveur local, dans un dossier temporaire neuf. */
function engineFor({ prefix = '', timings = {}, launch, feed, request = fetch } = {}) {
  counter += 1;
  const tempDir = path.join(workDir, `temp-${counter}`);
  mkdirSync(tempDir);
  const logs = [];
  const engine = createUpdateEngine({ feed: feed ?? localFeed(`${base}${prefix}`), request, tempDir, timings, log: (message) => logs.push(message), ...(launch ? { launch } : {}) });
  return { engine, tempDir, dir: path.join(tempDir, DOWNLOAD_DIR), logs };
}

/** Code de l'erreur avec laquelle une promesse est rejetée. */
const codeOf = (promise) => promise.then(() => 'réussite inattendue', (error) => error?.code ?? `sans code : ${error}`);

// ---------------------------------------------------------------------------------
// Description de la dernière version
// ---------------------------------------------------------------------------------

test('description : lue à l’adresse fixe ; absente, aucune version n’est publiée', async () => {
  const { engine } = engineFor({ prefix: '/a' });
  // Rien n'est publié : l'adresse n'existe pas.
  assert.deepEqual(await engine.readManifest(), { status: 'none' });
  serve('/a/evolve-update.json', JSON.stringify({ schema: 1, version: '9.9.9' }), { type: 'application/json' });
  assert.deepEqual(await engine.readManifest(), { status: 'ok', data: { schema: 1, version: '9.9.9' } });
  // Une marque d'ordre des octets en tête de fichier est ignorée.
  serve('/a/evolve-update.json', `\uFEFF${JSON.stringify({ schema: 1 })}`);
  assert.deepEqual(await engine.readManifest(), { status: 'ok', data: { schema: 1 } });
  assert.deepEqual(engine.describe(), { feed: 'local', page: `${base}/a`, dir: engine.dir });
});

test('description : serveur en erreur, contenu illisible ou démesuré, absence de réponse — chaque cas a son code', async () => {
  const { engine } = engineFor({ prefix: '/b', timings: { manifest: 150 } });
  serve('/b/evolve-update.json', 'panne', { status: 500 });
  assert.equal(await codeOf(engine.readManifest()), 'unreachable');
  serve('/b/evolve-update.json', 'interdit', { status: 403 });
  assert.equal(await codeOf(engine.readManifest()), 'unreachable');
  serve('/b/evolve-update.json', '{ "schema": 1, ');
  assert.equal(await codeOf(engine.readManifest()), 'invalid-manifest');
  serve('/b/evolve-update.json', '<html>Page de connexion</html>', { type: 'text/html' });
  assert.equal(await codeOf(engine.readManifest()), 'invalid-manifest');
  // Une description de quelques lignes ne pèse jamais des dizaines de kilo-octets.
  serve('/b/evolve-update.json', JSON.stringify({ schema: 1, remplissage: 'x'.repeat(MANIFEST_LIMIT) }));
  assert.equal(await codeOf(engine.readManifest()), 'invalid-manifest');
  // Le serveur ne répond pas : la lecture est abandonnée après le délai.
  routes.set('/b/evolve-update.json', () => {});
  const started = Date.now();
  assert.equal(await codeOf(engine.readManifest()), 'offline');
  assert.ok(Date.now() - started < 5000);
  // Aucun serveur à cette adresse.
  const nowhere = createUpdateEngine({ feed: localFeed('http://127.0.0.1:9'), request: fetch, tempDir: workDir });
  assert.equal(await codeOf(nowhere.readManifest()), 'offline');
  assert.equal(DEFAULT_TIMINGS.manifest, 20_000);
});

test('description : une redirection est suivie ; sur la voie normale, une réponse hors https est refusée', async () => {
  const { engine } = engineFor({ prefix: '/c' });
  routes.set('/c/evolve-update.json', (_request, response) => response.writeHead(302, { location: '/c/ailleurs.json' }).end());
  serve('/c/ailleurs.json', JSON.stringify({ schema: 1, version: '9.9.9' }));
  assert.deepEqual(await engine.readManifest(), { status: 'ok', data: { schema: 1, version: '9.9.9' } });

  /** Réponse fabriquée : une description valable, venue de l'adresse indiquée. */
  const answerFrom = (url) => async () => ({
    ok: true,
    status: 200,
    url,
    headers: new Headers(),
    body: (async function* body() {
      yield Buffer.from(JSON.stringify({ schema: 1, version: '9.9.9' }));
    })(),
  });

  // Voie normale (https exigé) : une réponse venue d'une adresse « http » — après une redirection — est refusée
  // avant d'être lue.
  const strict = createUpdateEngine({ feed: productionFeed(), request: answerFrom(`${base}/c/ailleurs.json`), tempDir: workDir });
  const error = await strict.readManifest().then(() => null, (reason) => reason);
  assert.equal(error.code, 'unreachable');
  assert.match(error.message, /adresse non admise \(http:\/\/127\.0\.0\.1\)/);
  const secure = createUpdateEngine({ feed: productionFeed(), request: answerFrom('https://release-assets.githubusercontent.com/x'), tempDir: workDir });
  assert.deepEqual(await secure.readManifest(), { status: 'ok', data: { schema: 1, version: '9.9.9' } });
  // Voie d'essai : une réponse venue d'une autre machine est refusée.
  const away = createUpdateEngine({ feed: localFeed(base), request: answerFrom('http://192.168.1.20/evolve-update.json'), tempDir: workDir });
  assert.equal(await codeOf(away.readManifest()), 'unreachable');
  const garbled = createUpdateEngine({ feed: localFeed(base), request: answerFrom('pas une adresse'), tempDir: workDir });
  assert.match((await garbled.readManifest().then(() => null, (reason) => reason)).message, /adresse non admise \(adresse illisible\)/);
  // Le moteur d'Electron n'indique pas l'adresse de ses réponses : rien n'est contrôlable ici — l'hôte a refusé
  // lui-même toute autre adresse (voir tests/main-process.test.mjs).
  for (const url of ['', undefined, null]) {
    const silent = createUpdateEngine({ feed: productionFeed(), request: answerFrom(url), tempDir: workDir });
    assert.deepEqual(await silent.readManifest(), { status: 'ok', data: { schema: 1, version: '9.9.9' } });
  }
});

test('aucune requête ne part vers une adresse que la voie de publication n’admet pas', async () => {
  const asked = [];
  const request = async (url) => {
    asked.push(url);
    throw new Error('aucune requête ne devait partir');
  };
  // Une voie de publication dont les adresses ne sont pas celles qu'elle admet (cas impossible avec les deux
  // voies réelles) : le moteur refuse, sans rien demander.
  const feed = { ...productionFeed(), manifestUrl: `${base}/x/evolve-update.json`, setupUrl: (version) => `${base}/x/Evolve-Setup-${version}.exe` };
  const engine = createUpdateEngine({ feed, request, tempDir: path.join(workDir, 'refus') });
  assert.equal(await codeOf(engine.readManifest()), 'unreachable');
  assert.equal(await codeOf(engine.download(manifestOf('9.9.9'))), 'unreachable');
  assert.deepEqual(asked, []);
  assert.deepEqual(existsSync(engine.dir) ? readdirSync(engine.dir) : [], []);
  // Sans règle d'admission, aucun moteur n'est construit.
  assert.throws(() => createUpdateEngine({ feed: { manifestUrl: 'https://exemple.invalid/x', setupUrl: () => 'https://exemple.invalid/y' }, request, tempDir: workDir }), /quelles adresses elle admet/);
});

// ---------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------

test('téléchargement : le fichier reçu est celui qui est publié, à l’octet près, et sa progression est annoncée', async () => {
  const bytes = setupBytes('9.9.9');
  serve('/d/Evolve-Setup-9.9.9.exe', bytes);
  const { engine, dir } = engineFor({ prefix: '/d' });
  assert.equal(existsSync(dir), false, 'aucun dossier tant que rien n’est téléchargé');
  const progress = [];
  const { file } = await engine.download(manifestOf('9.9.9'), { onProgress: (received) => progress.push(received) });
  assert.equal(file, path.join(dir, 'Evolve-Setup-9.9.9.exe'));
  assert.ok(readFileSync(file).equals(bytes));
  assert.deepEqual(readdirSync(dir), ['Evolve-Setup-9.9.9.exe']);
  // Progression croissante, jusqu'à la taille exacte.
  assert.ok(progress.length >= 1);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.equal(progress.at(-1), bytes.length);

  // Déjà téléchargé et intact : repris tel quel, sans aucune requête.
  const before = hits.length;
  const again = [];
  assert.deepEqual(await engine.download(manifestOf('9.9.9'), { onProgress: (received) => again.push(received) }), { file });
  assert.equal(hits.length, before);
  assert.deepEqual(again, [bytes.length]);
});

test('téléchargement : le dossier ne garde ni téléchargement inachevé, ni ancienne version', async () => {
  const bytes = setupBytes('9.9.9');
  serve('/e/Evolve-Setup-9.9.9.exe', bytes);
  const { engine, dir } = engineFor({ prefix: '/e' });
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'Evolve-Setup-9.9.8.exe'), 'ancienne version');
  writeFileSync(path.join(dir, 'Evolve-Setup-9.9.9.exe'), 'téléchargement inachevé');
  writeFileSync(path.join(dir, 'autre.tmp'), 'x');
  // Un sous-dossier, que le moteur ne crée jamais, n'est pas touché.
  mkdirSync(path.join(dir, 'sous-dossier'));
  writeFileSync(path.join(dir, 'sous-dossier', 'fichier.txt'), 'x');
  const { file } = await engine.download(manifestOf('9.9.9'));
  assert.ok(readFileSync(file).equals(bytes));
  assert.deepEqual(readdirSync(dir).sort(), ['Evolve-Setup-9.9.9.exe', 'sous-dossier']);
  assert.deepEqual(readdirSync(path.join(dir, 'sous-dossier')), ['fichier.txt']);
});

test('téléchargement : un fichier qui n’est pas celui publié est refusé, et ne reste pas sur le disque', async () => {
  const bytes = setupBytes('9.9.9');
  const manifest = manifestOf('9.9.9');
  const { engine, dir } = engineFor({ prefix: '/f' });
  const left = () => (existsSync(dir) ? readdirSync(dir) : []);

  // Même taille, contenu différent : l'empreinte ne correspond pas.
  const tampered = Buffer.from(bytes);
  tampered[1234] ^= 0xff;
  serve('/f/Evolve-Setup-9.9.9.exe', tampered);
  assert.equal(await codeOf(engine.download(manifest)), 'checksum');
  assert.deepEqual(left(), []);
  // Taille annoncée différente : refusé avant tout téléchargement.
  serve('/f/Evolve-Setup-9.9.9.exe', Buffer.concat([bytes, Buffer.from('x')]));
  assert.equal(await codeOf(engine.download(manifest)), 'checksum');
  assert.deepEqual(left(), []);
  serve('/f/Evolve-Setup-9.9.9.exe', bytes.subarray(0, 1000));
  assert.equal(await codeOf(engine.download(manifest)), 'checksum');
  // Taille non annoncée, fichier plus long que prévu : interrompu dès le dépassement.
  routes.set('/f/Evolve-Setup-9.9.9.exe', (_request, response) => {
    response.writeHead(200);
    response.write(bytes);
    response.end(Buffer.alloc(64 * 1024, 'x'));
  });
  assert.equal(await codeOf(engine.download(manifest)), 'checksum');
  assert.deepEqual(left(), []);
  // Taille non annoncée, fichier plus court.
  routes.set('/f/Evolve-Setup-9.9.9.exe', (_request, response) => {
    response.writeHead(200);
    response.end(bytes.subarray(0, 4096));
  });
  assert.equal(await codeOf(engine.download(manifest)), 'checksum');
  assert.deepEqual(left(), []);
  // Fichier absent du serveur, ou serveur en erreur.
  routes.delete('/f/Evolve-Setup-9.9.9.exe');
  assert.equal(await codeOf(engine.download(manifest)), 'download-failed');
  serve('/f/Evolve-Setup-9.9.9.exe', 'panne', { status: 503 });
  assert.equal(await codeOf(engine.download(manifest)), 'download-failed');
  assert.deepEqual(left(), []);
  // La connexion est coupée en cours de route.
  routes.set('/f/Evolve-Setup-9.9.9.exe', (_request, response) => {
    response.writeHead(200, { 'content-length': bytes.length });
    response.write(bytes.subarray(0, 50_000));
    setTimeout(() => response.destroy(), 30);
  });
  assert.equal(await codeOf(engine.download(manifest)), 'download-failed');
  assert.deepEqual(left(), []);

  // Le bon fichier, enfin : accepté.
  serve('/f/Evolve-Setup-9.9.9.exe', bytes);
  const { file } = await engine.download(manifest);
  assert.ok(readFileSync(file).equals(bytes));
});

test('téléchargement : interrompu à la demande, ou abandonné faute de données — rien ne reste', async () => {
  const bytes = setupBytes('9.9.9');
  const manifest = manifestOf('9.9.9');
  // Le serveur envoie le début, puis attend.
  routes.set('/g/Evolve-Setup-9.9.9.exe', (_request, response) => {
    response.writeHead(200, { 'content-length': bytes.length });
    response.write(bytes.subarray(0, 100_000));
  });
  const { engine, dir } = engineFor({ prefix: '/g', timings: { stall: 200 } });

  // Interruption demandée par l'utilisateur, après le premier morceau reçu.
  const controller = new AbortController();
  const pending = engine.download(manifest, { signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(await codeOf(pending), 'cancelled');
  assert.deepEqual(readdirSync(dir), []);
  // Déjà interrompu avant de commencer : aucune requête.
  const before = hits.length;
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await codeOf(engine.download(manifest, { signal: aborted.signal })), 'cancelled');
  assert.equal(hits.length, before);

  // Plus aucune donnée : abandonné après le délai, sans attendre indéfiniment.
  const started = Date.now();
  assert.equal(await codeOf(engine.download(manifest)), 'download-failed');
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(readdirSync(dir), []);
  // Le serveur ne répond pas du tout.
  routes.set('/g/Evolve-Setup-9.9.9.exe', () => {});
  assert.equal(await codeOf(engine.download(manifest)), 'download-failed');
  assert.equal(DEFAULT_TIMINGS.stall, 60_000);
});

test('téléchargement : un dossier temporaire inutilisable est signalé comme un problème de disque', async () => {
  serve('/h/Evolve-Setup-9.9.9.exe', setupBytes('9.9.9'));
  const { engine, tempDir } = engineFor({ prefix: '/h' });
  // Un fichier occupe la place du dossier des téléchargements.
  writeFileSync(path.join(tempDir, DOWNLOAD_DIR), 'pas un dossier');
  assert.equal(await codeOf(engine.download(manifestOf('9.9.9'))), 'disk');
  assert.equal(readFileSync(path.join(tempDir, DOWNLOAD_DIR), 'utf8'), 'pas un dossier');
});

// ---------------------------------------------------------------------------------
// Lancement de l'installateur
// ---------------------------------------------------------------------------------

/** Faux lancement : note ce qui est demandé, puis signale que le programme a démarré (ou n'a pas pu). */
function fakeLaunch({ error = null } = {}) {
  const calls = [];
  const launch = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => calls.push('unref');
    setImmediate(() => (error ? child.emit('error', error) : child.emit('spawn')));
    return child;
  };
  return { launch, calls };
}

test('installation : seul l’installateur téléchargé et vérifié est lancé, avec des arguments fixés', async () => {
  const bytes = setupBytes('9.9.9');
  const manifest = manifestOf('9.9.9');
  serve('/i/Evolve-Setup-9.9.9.exe', bytes);
  const { launch, calls } = fakeLaunch();
  const { engine, dir } = engineFor({ prefix: '/i', launch });
  const { file } = await engine.download(manifest);

  assert.deepEqual(await engine.install(file, manifest), { pid: 4242 });
  // Mise à jour silencieuse, Evolve rouvert ensuite ; programme détaché, qui survit à la fermeture d'Evolve.
  assert.deepEqual(calls, [{ file: path.join(dir, 'Evolve-Setup-9.9.9.exe'), args: ['--updated', '/S', '--force-run'], options: { detached: true, stdio: 'ignore' } }, 'unref']);
  assert.deepEqual([...INSTALL_ARGUMENTS], ['--updated', '/S', '--force-run']);
  assert.ok(Object.isFrozen(INSTALL_ARGUMENTS));

  // Un autre fichier, même identique, n'est jamais lancé : seul compte celui du dossier des téléchargements.
  calls.length = 0;
  const copy = path.join(workDir, 'Evolve-Setup-9.9.9.exe');
  writeFileSync(copy, bytes);
  for (const other of [copy, path.join(dir, 'autre.exe'), path.join(dir, '..', 'Evolve-Setup-9.9.9.exe'), '', 'Evolve-Setup-9.9.9.exe', null]) {
    assert.equal(await codeOf(engine.install(other, manifest)), 'install-failed', String(other));
  }
  // Le fichier porte le nom d'une autre version que celle décrite.
  assert.equal(await codeOf(engine.install(file, manifestOf('9.9.8', bytes))), 'install-failed');
  assert.deepEqual(calls, []);
});

test('installation : un fichier modifié depuis sa vérification n’est pas lancé — il est supprimé', async () => {
  const bytes = setupBytes('9.9.9');
  const manifest = manifestOf('9.9.9');
  serve('/j/Evolve-Setup-9.9.9.exe', bytes);
  const { launch, calls } = fakeLaunch();
  const { engine } = engineFor({ prefix: '/j', launch });
  const { file } = await engine.download(manifest);

  // Entre le téléchargement et l'installation, le fichier change (même taille).
  const altered = Buffer.from(bytes);
  altered[0] ^= 0xff;
  writeFileSync(file, altered);
  assert.equal(await codeOf(engine.install(file, manifest)), 'checksum');
  assert.deepEqual(calls, []);
  assert.equal(existsSync(file), false, 'le fichier non conforme est supprimé');
  // Le fichier a disparu.
  assert.equal(await codeOf(engine.install(file, manifest)), 'checksum');
  assert.deepEqual(calls, []);

  // Le programme ne peut pas être lancé : l'échec est rapporté.
  await engine.download(manifest);
  const refused = fakeLaunch({ error: new Error('accès refusé') });
  const blocked = createUpdateEngine({ feed: localFeed(`${base}/j`), request: fetch, tempDir: path.dirname(engine.dir), launch: refused.launch });
  assert.equal(await codeOf(blocked.install(file, manifest)), 'install-failed');
  const throwing = createUpdateEngine({
    feed: localFeed(`${base}/j`),
    request: fetch,
    tempDir: path.dirname(engine.dir),
    launch: () => {
      throw new Error('lancement impossible');
    },
  });
  assert.equal(await codeOf(throwing.install(file, manifest)), 'install-failed');
});

test(
  'installation : le programme est réellement lancé, détaché, avec les trois arguments',
  { skip: process.platform === 'win32' ? 'lancement d’un faux installateur écrit en script : sous Windows, la compilation automatique lance le véritable installateur' : false },
  async () => {
    // Le « fichier publié » est ici un script, qui note les arguments reçus : le vrai lancement de Node est éprouvé.
    const out = path.join(workDir, 'arguments-recus.txt');
    const script = Buffer.from(`#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`);
    const manifest = manifestOf('9.9.9', script);
    serve('/k/Evolve-Setup-9.9.9.exe', script);
    const { engine } = engineFor({ prefix: '/k' });
    const { file } = await engine.download(manifest);
    chmodSync(file, 0o755);
    const { pid } = await engine.install(file, manifest);
    assert.ok(Number.isInteger(pid) && pid > 0);
    for (let attempt = 0; attempt < 100 && !existsSync(out); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readFileSync(out, 'utf8'), '--updated\n/S\n--force-run\n');
  },
);

// ---------------------------------------------------------------------------------
// Ménage
// ---------------------------------------------------------------------------------

test('ménage au lancement : seul un installateur plus récent que la version en cours est conservé', () => {
  const { engine, dir } = engineFor();
  const newer = (version, current) => compareVersions(version, current) > 0;
  // Aucun dossier : rien à faire, rien n'est créé.
  assert.deepEqual(engine.cleanup({ current: '0.6.0', newer }), []);
  assert.equal(existsSync(dir), false);

  mkdirSync(dir);
  for (const name of ['Evolve-Setup-0.5.0.exe', 'Evolve-Setup-0.6.0.exe', 'Evolve-Setup-0.7.0.exe', 'Evolve-Setup-0.7.0.exe.part', 'Evolve-Setup-x.y.z.exe', 'autre.txt']) writeFileSync(path.join(dir, name), 'x');
  // Après une mise à jour vers 0.6.0 : l'installateur de cette version, devenu inutile, est retiré.
  assert.deepEqual(engine.cleanup({ current: '0.6.0', newer }).sort(), ['Evolve-Setup-0.5.0.exe', 'Evolve-Setup-0.6.0.exe', 'Evolve-Setup-0.7.0.exe.part', 'Evolve-Setup-x.y.z.exe', 'autre.txt']);
  assert.deepEqual(readdirSync(dir), ['Evolve-Setup-0.7.0.exe']);
  // Une fois la version 0.7.0 installée, il ne reste rien : le dossier lui-même est retiré.
  assert.deepEqual(engine.cleanup({ current: '0.7.0', newer }), ['Evolve-Setup-0.7.0.exe']);
  assert.equal(existsSync(dir), false);

  // Une comparaison impossible ne conserve rien.
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'Evolve-Setup-0.9.0.exe'), 'x');
  assert.deepEqual(
    engine.cleanup({
      current: 'inconnue',
      newer: () => {
        throw new Error('version invalide');
      },
    }),
    ['Evolve-Setup-0.9.0.exe'],
  );
  assert.equal(existsSync(dir), false);
});

// ---------------------------------------------------------------------------------
// Ce que le module se permet
// ---------------------------------------------------------------------------------

test('le moteur ne lance qu’un programme — l’installateur vérifié — et n’écrit que dans son dossier temporaire', () => {
  const code = stripComments(readText('src/main/update-engine.js'));
  // Un seul lancement de programme, avec la liste d'arguments fixée.
  assert.equal([...code.matchAll(/\blaunch\(/g)].length, 1);
  assert.match(code, /child = launch\(expected, \[\.\.\.INSTALL_ARGUMENTS\], \{ detached: true, stdio: 'ignore' \}\);/);
  assert.match(code, /launch = childProcess\.spawn/);
  assert.equal([...code.matchAll(/\bchildProcess\b/g)].length, 2, 'une importation, un usage');
  assert.doesNotMatch(code, /\bexec(?:File)?(?:Sync)?\(|\bspawnSync\b|\bfork\(|shell: true/);
  // Avant de le lancer, son empreinte est vérifiée.
  assert.match(code, /if \(!\(await matches\(expected, manifest\)\)\) \{\s+discard\(expected\);\s+throw coded\('checksum'/);
  // L'adresse de l'installateur vient du numéro de version, jamais de la description publiée.
  assert.match(code, /request\(checkTarget\(feed\.setupUrl\(manifest\.version\)\), /);
  assert.doesNotMatch(code, /manifest\.(?:url|path|file)\b/);
  // Deux requêtes en tout, chacune vers une adresse que la voie de publication admet.
  assert.equal([...code.matchAll(/\brequest\(/g)].length, 2);
  assert.equal([...code.matchAll(/\brequest\(checkTarget\(/g)].length, 2);
  // Aucune dépendance à Electron : les requêtes passent par la fonction remise par l'hôte.
  assert.deepEqual([...code.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]), ['node:crypto', 'node:fs', 'node:path', 'node:child_process', '../services/updates']);
  // Tout ce qu'il écrit ou supprime se trouve dans son dossier, désigné une fois pour toutes.
  assert.match(code, /const dir = path\.join\(tempDir, DOWNLOAD_DIR\);/);
  assert.equal(DOWNLOAD_DIR, 'Evolve-mise-a-jour');
  assert.doesNotMatch(code, /recursive: true, force: true|rmSync\([^)]*recursive/);
});
