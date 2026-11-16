'use strict';

/**
 * Evolve — Moteur des mises à jour.
 *
 * Ce que le service des mises à jour décide (src/services/updates.js), ce
 * module le fait. Trois gestes, et rien d'autre :
 *
 *   1. lire la description de la dernière version publiée — quelques lignes
 *      de JSON, à une adresse fixe ;
 *   2. télécharger l'installateur de cette version dans le dossier temporaire
 *      de l'utilisateur. Le fichier n'est tenu pour valable que si sa taille
 *      et son empreinte SHA-512 sont celles de la description ; sinon il est
 *      supprimé ;
 *   3. lancer cet installateur — lui seul, après avoir vérifié son empreinte
 *      une dernière fois, avec des arguments fixés ici.
 *
 * L'adresse de l'installateur n'est jamais lue dans la description : elle se
 * déduit du numéro de version (voir `feed.setupUrl`). Les requêtes passent par
 * la fonction remise par l'hôte. Seules les adresses que la voie de
 * publication admet (`feed.admits` : « https » sur la voie normale) sont
 * acceptées, y compris après une redirection : une réponse qui indique d'où
 * elle vient est contrôlée ici ; l'hôte, lui, doit refuser les autres
 * adresses à chaque étape d'une requête — le moteur d'Electron n'indique pas
 * l'adresse de ses réponses (voir `createUpdateRequest`, main.js).
 *
 * Aucune dépendance à Electron : les tests exécutent ce module avec Node,
 * contre un serveur local.
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { setupFileName } = require('../services/updates');

/** Dossier des téléchargements, dans le dossier temporaire de l'utilisateur. */
const DOWNLOAD_DIR = 'Evolve-mise-a-jour';

/** Taille maximale de la description d'une version. */
const MANIFEST_LIMIT = 64 * 1024;

/** Durées, en millisecondes (réduites par les tests). */
const DEFAULT_TIMINGS = Object.freeze({
  /** Attente maximale de la description d'une version. */
  manifest: 20_000,
  /** Durée sans aucune donnée reçue au-delà de laquelle un téléchargement est abandonné. */
  stall: 60_000,
});

/**
 * Arguments passés à l'installateur : il s'agit d'une mise à jour (les
 * raccourcis et les réglages sont conservés), aucune fenêtre n'est affichée,
 * et Evolve est rouvert une fois l'installation terminée.
 */
const INSTALL_ARGUMENTS = Object.freeze(['--updated', '/S', '--force-run']);

/** Installateurs présents dans le dossier des téléchargements : « Evolve-Setup-1.2.3.exe ». */
const SETUP_NAME = /^Evolve-Setup-(\d+\.\d+\.\d+)\.exe$/;

/** Erreur dont le code est compris du service des mises à jour. */
function coded(code, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause ?? code);
  return Object.assign(new Error(detail), { code });
}

/**
 * @param {object} options
 * @param {{ manifestUrl: string, setupUrl: (version: string) => string, admits: (address: string) => boolean, kind: string, page: string }} options.feed
 *        adresses de publication (voir src/services/updates.js)
 * @param {(url: string, init: object) => Promise<Response>} options.request  requête réseau, de la forme
 *        de la fonction standard du même usage ; fournie par l'hôte
 * @param {string} options.tempDir  dossier temporaire de l'utilisateur
 * @param {object} [options.fs]  module de fichiers (remplacé par les tests)
 * @param {(file: string, args: string[], options: object) => object} [options.launch]  lancement d'un
 *        programme (remplacé par les tests)
 * @param {Partial<typeof DEFAULT_TIMINGS>} [options.timings]
 * @param {(message: string) => void} [options.log]
 */
function createUpdateEngine({ feed, request, tempDir, fs = nodeFs, launch = childProcess.spawn, timings = {}, log = () => {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings };
  const dir = path.join(tempDir, DOWNLOAD_DIR);

  if (typeof feed?.admits !== 'function') throw new TypeError('Mises à jour : la voie de publication doit dire quelles adresses elle admet.');

  /**
   * Refuse une réponse venue d'une adresse que cette voie de publication
   * n'admet pas. Une réponse sans adresse (moteur d'Electron) n'est pas
   * contrôlable ici : l'hôte a déjà refusé toute autre adresse, à chaque étape.
   */
  function checkOrigin(response) {
    const address = response?.url;
    if (address === '' || address === undefined || address === null) return;
    if (feed.admits(address) === true) return;
    let shown = 'adresse illisible';
    try {
      const url = new URL(String(address));
      shown = `${url.protocol}//${url.hostname}`;
    } catch {
      /* adresse illisible */
    }
    throw coded('unreachable', `réponse venue d'une adresse non admise (${shown})`);
  }

  /** Refuse de demander une adresse que cette voie de publication n'admet pas. */
  function checkTarget(address) {
    if (feed.admits(address) !== true) throw coded('unreachable', 'adresse de publication non admise');
    return address;
  }

  /** Empreinte SHA-512 d'un fichier, ou `null` s'il ne peut pas être lu. */
  function digestOf(file) {
    return new Promise((resolve) => {
      const hash = crypto.createHash('sha512');
      const stream = fs.createReadStream(file);
      stream.on('error', () => resolve(null));
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /** Vrai si `file` est exactement l'installateur que décrit `manifest` : même taille, même empreinte. */
  async function matches(file, manifest) {
    try {
      const info = fs.statSync(file);
      if (!info.isFile() || info.size !== manifest.size) return false;
    } catch {
      return false;
    }
    return (await digestOf(file)) === manifest.sha512;
  }

  /** Supprime un fichier du dossier des téléchargements, sans jamais lever d'exception. */
  function discard(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      log(`Mises à jour : fichier temporaire non supprimé (${error?.message ?? error}).`);
    }
  }

  /** Fichiers du dossier des téléchargements (liste vide s'il n'existe pas). */
  function entries() {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name);
    } catch {
      return [];
    }
  }

  return {
    /** Dossier où les installateurs sont téléchargés. */
    dir,

    /**
     * Lit la description de la dernière version publiée.
     * @returns {Promise<{ status: 'none' } | { status: 'ok', data: any }>} « none » : aucune version publiée
     */
    async readManifest() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), t.manifest);
      try {
        let response;
        try {
          response = await request(checkTarget(feed.manifestUrl), { signal: controller.signal, redirect: 'follow', cache: 'no-store', headers: { accept: 'application/json' } });
        } catch (error) {
          if (error?.code === 'unreachable') throw error;
          throw coded('offline', error);
        }
        // Tant qu'aucune version n'est publiée, l'adresse n'existe pas.
        if (response.status === 404) return { status: 'none' };
        if (!response.ok) throw coded('unreachable', `code ${response.status}`);
        checkOrigin(response);

        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MANIFEST_LIMIT) throw coded('invalid-manifest', 'description trop volumineuse');
            chunks.push(Buffer.from(chunk));
          }
        } catch (error) {
          if (error?.code === 'invalid-manifest') throw error;
          throw coded('offline', error);
        }
        try {
          return { status: 'ok', data: JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) };
        } catch (error) {
          throw coded('invalid-manifest', error);
        }
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Télécharge l'installateur de la version décrite par `manifest`.
     * @param {{ version: string, size: number, sha512: string }} manifest  description contrôlée par le service
     * @param {{ onProgress?: (received: number) => void, signal?: AbortSignal }} [options]
     * @returns {Promise<{ file: string }>} le fichier, vérifié
     */
    async download(manifest, { onProgress = () => {}, signal = null } = {}) {
      const name = setupFileName(manifest.version);
      const target = path.join(dir, name);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw coded('disk', error);
      }
      // Déjà téléchargé lors d'une session précédente, et intact : il est repris tel quel.
      if (await matches(target, manifest)) {
        onProgress(manifest.size);
        return { file: target };
      }
      // Rien d'autre ne reste dans le dossier : ni téléchargement inachevé, ni ancienne version.
      for (const other of entries()) discard(path.join(dir, other));

      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal) {
        if (signal.aborted) throw coded('cancelled');
        signal.addEventListener('abort', abort, { once: true });
      }
      let stalled = false;
      let timer = null;
      const watch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          controller.abort();
        }, t.stall);
      };

      let output = null;
      try {
        watch();
        let response;
        try {
          response = await request(checkTarget(feed.setupUrl(manifest.version)), { signal: controller.signal, redirect: 'follow', cache: 'no-store' });
        } catch (error) {
          if (error?.code === 'unreachable') throw error;
          throw coded(signal?.aborted ? 'cancelled' : 'download-failed', error);
        }
        if (!response.ok) throw coded('download-failed', `code ${response.status}`);
        checkOrigin(response);
        // Une taille annoncée différente : inutile de télécharger, ce n'est pas le fichier décrit.
        const announced = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(announced) && announced > 0 && announced !== manifest.size) throw coded('checksum', `taille annoncée ${announced}, attendue ${manifest.size}`);

        const hash = crypto.createHash('sha512');
        let received = 0;
        let writeError = null;
        output = fs.createWriteStream(target);
        output.on('error', (error) => {
          writeError = error;
          controller.abort();
        });
        try {
          for await (const chunk of response.body) {
            watch();
            received += chunk.length;
            if (received > manifest.size) throw coded('checksum', 'fichier plus volumineux que la taille publiée');
            hash.update(chunk);
            if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
            if (writeError) break;
            onProgress(received);
          }
        } catch (error) {
          if (writeError) throw coded('disk', writeError);
          if (error?.code === 'checksum') throw error;
          throw coded(signal?.aborted ? 'cancelled' : 'download-failed', stalled ? 'aucune donnée reçue' : error);
        }
        if (writeError) throw coded('disk', writeError);
        // Interrompu sans que la lecture ait échoué (le flux s'est simplement arrêté) : ce n'est pas un fichier complet.
        if (controller.signal.aborted) throw coded(signal?.aborted ? 'cancelled' : 'download-failed', stalled ? 'aucune donnée reçue' : 'téléchargement interrompu');
        await new Promise((resolve) => output.end(resolve));
        if (writeError) throw coded('disk', writeError);
        output = null;

        if (received !== manifest.size) throw coded('checksum', `taille reçue ${received}, attendue ${manifest.size}`);
        if (hash.digest('hex') !== manifest.sha512) throw coded('checksum', 'empreinte différente de celle publiée');
        return { file: target };
      } catch (error) {
        // Un fichier incomplet ou non conforme ne reste pas sur le disque.
        if (output && !output.closed) {
          const stream = output;
          await new Promise((resolve) => {
            stream.once('close', resolve);
            stream.destroy();
          });
        }
        discard(target);
        throw error;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
    },

    /**
     * Lance l'installateur téléchargé. Il doit se trouver dans le dossier des
     * téléchargements, porter le nom de la version décrite, et avoir — à cet
     * instant encore — l'empreinte publiée.
     * @returns {Promise<{ pid: number|null }>}
     */
    async install(file, manifest) {
      const expected = path.join(dir, setupFileName(manifest.version));
      if (path.resolve(String(file)) !== path.resolve(expected)) throw coded('install-failed', 'fichier inattendu');
      if (!(await matches(expected, manifest))) {
        discard(expected);
        throw coded('checksum', "l'installateur ne correspond plus à l'empreinte publiée");
      }
      return new Promise((resolve, reject) => {
        let child;
        try {
          // Détaché : l'installateur continue après la fermeture d'Evolve, qu'il attend pour remplacer ses fichiers.
          child = launch(expected, [...INSTALL_ARGUMENTS], { detached: true, stdio: 'ignore' });
        } catch (error) {
          reject(coded('install-failed', error));
          return;
        }
        child.once('error', (error) => reject(coded('install-failed', error)));
        child.once('spawn', () => {
          child.unref?.();
          resolve({ pid: child.pid ?? null });
        });
      });
    },

    /**
     * Ménage du dossier des téléchargements, au lancement : seul un
     * installateur d'une version plus récente que `current` est conservé — il
     * sera vérifié de nouveau avant tout usage. Le dossier, vide, est retiré.
     * @param {{ current: string, newer: (version: string, current: string) => boolean }} options
     * @returns {string[]} noms des fichiers supprimés
     */
    cleanup({ current, newer }) {
      const removed = [];
      for (const name of entries()) {
        const version = name.match(SETUP_NAME)?.[1] ?? null;
        let keep = false;
        try {
          keep = version !== null && newer(version, current) === true;
        } catch {
          keep = false;
        }
        if (keep) continue;
        discard(path.join(dir, name));
        removed.push(name);
      }
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        /* le dossier sera retiré une prochaine fois */
      }
      return removed;
    },

    /** Description de la voie de publication, pour les comptes rendus. */
    describe() {
      return { feed: feed.kind, page: feed.page, dir };
    },
  };
}

module.exports = { createUpdateEngine, DOWNLOAD_DIR, INSTALL_ARGUMENTS, DEFAULT_TIMINGS, MANIFEST_LIMIT };
