'use strict';

/**
 * Evolve — Service des mises à jour.
 *
 * Indique si une version plus récente d'Evolve est publiée, la télécharge et
 * lance son installation. Trois précautions structurent ce service :
 *
 *   - il ne parle qu'à des adresses connues : une version est cherchée sur
 *     l'interface publique de GitHub, en HTTPS, et nulle part ailleurs ;
 *   - un fichier téléchargé n'est jamais lancé sans que son empreinte SHA-256
 *     corresponde à celle publiée à côté de lui (SHA256SUMS.txt) ; à défaut
 *     d'empreinte, le téléchargement est refusé ;
 *   - rien n'est installé sans que l'utilisateur ne l'ait demandé depuis
 *     l'interface : le service ne décide jamais seul.
 *
 * La vérification est sans effet sur le reste du système : elle ne lit et
 * n'écrit que le dossier de téléchargement qui lui est indiqué.
 *
 * Aucune dépendance à Electron ni à l'interface : l'accès réseau, les fichiers
 * et l'horloge sont fournis par l'appelant.
 */

const { createHash } = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { Readable } = require('node:stream');

const { ServiceError } = require('./hub');

/** Seuls hôtes contactés : l'interface publique de GitHub, en HTTPS. */
const HOSTS = Object.freeze(['api.github.com', 'github.com', 'objects.githubusercontent.com']);
/** Fichier d'empreintes publié avec chaque version. */
const CHECKSUM_ASSET = 'SHA256SUMS.txt';
const USER_AGENT = 'Evolve';
/** Délai au-delà duquel une demande réseau est abandonnée. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Taille maximale acceptée pour un fichier téléchargé (500 Mo). */
const MAX_BYTES = 500 * 1024 * 1024;
/** Deux annonces de progression sont espacées d'au moins cette durée. */
const PROGRESS_INTERVAL_MS = 120;

/**
 * Nom du fichier attendu selon la façon dont Evolve est lancé :
 *   portable  exécutable portable (ne peut pas se remplacer lui-même) ;
 *   user      installateur pour l'utilisateur courant (sans droits d'administrateur) ;
 *   machine   installateur pour tous les utilisateurs (droits d'administrateur).
 */
const ASSET_TEMPLATES = Object.freeze({
  portable: 'Evolve-${version}-portable.exe',
  user: 'Evolve-${version}-setup.exe',
  machine: 'Evolve-${version}-setup-tous-utilisateurs.exe',
});

/** Types d'installation connus. */
const CHANNELS = Object.freeze(Object.keys(ASSET_TEMPLATES));

/**
 * Décompose un numéro de version ( « v0.4.1 » → 0, 4, 1 ).
 * @returns {{ major: number, minor: number, patch: number, text: string }|null}
 */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? '0'),
    text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? '0')}`,
  };
}

/** Compare deux numéros de version : -1, 0 ou 1. Une version illisible est la plus ancienne. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return 0;
}

/** Nom du fichier attendu pour un type d'installation, ou `null`. */
function assetNameFor(channel, version, assets) {
  const template = assets[channel];
  if (!template) return null;
  return template.replaceAll('${version}', version);
}

/** Adresse HTTPS autorisée, ou `null` si l'hôte n'est pas l'un de ceux attendus. */
function allowedUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || !HOSTS.includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Empreinte attendue pour un fichier, lue dans un fichier d'empreintes
 * (une ligne par fichier : « <empreinte>  <nom> »).
 * @returns {string|null}
 */
function checksumFor(text, name) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})[ \t]+\*?(.+)$/i.exec(line.trim());
    if (!match) continue;
    const file = match[2].trim().replace(/^.*[\\/]/, '');
    if (file === name) return match[1].toLowerCase();
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {string|null} [options.currentVersion]  version en cours d'exécution
 * @param {'portable'|'user'|'machine'} [options.channel]  type d'installation
 * @param {{ owner: string, name: string }|null} [options.repo]  dépôt des versions publiées
 * @param {Record<string, string>} [options.assets]  noms de fichiers attendus
 * @param {typeof fetch|null} [options.fetchImpl]  accès réseau (injecté par les tests)
 * @param {string|null} [options.downloadDir]  dossier du téléchargement
 * @param {((file: string, info: { channel: string, version: string }) => Promise<{ ok: boolean, code?: string, message?: string }>)|null} [options.launch]
 *        lance l'installation d'un fichier déjà vérifié
 * @param {() => number} [options.now]
 * @param {object} [options.fs]
 * @param {object} [options.path]
 * @param {number} [options.maxBytes]
 * @param {number} [options.timeoutMs]
 * @param {(message: string) => void} [options.log]
 */
function createUpdatesService({
  currentVersion = null,
  channel = 'user',
  repo = null,
  assets = ASSET_TEMPLATES,
  fetchImpl = null,
  downloadDir = null,
  launch = null,
  now = () => Date.now(),
  fs = nodeFs,
  path = nodePath,
  maxBytes = MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : null;
  const available = Boolean(fetcher && repo?.owner && repo?.name && downloadDir && currentVersion);

  let checking = false;
  let downloading = false;
  /** Progression du téléchargement en cours : { loaded, total }. */
  let progress = null;
  /** Mise à jour téléchargée et vérifiée : { version, file, size, sha256 }. */
  let ready = null;
  /** Dernière version trouvée : { version, notes, publishedAt, url, asset }. */
  let latest = null;
  let lastCheck = 0;
  let lastError = null;

  const listeners = new Set();
  /** Avertit les abonnés d'un événement du service (jamais d'exception propagée). */
  const emit = (event, payload, origin = null) => {
    for (const listener of [...listeners]) {
      try {
        listener(event, payload, origin);
      } catch (error) {
        log(`Mises à jour : abonné en erreur sur ${event} : ${error?.message ?? error}`);
      }
    }
  };

  const updateAvailable = () => Boolean(latest && compareVersions(latest.version, currentVersion) > 0);

  /**
   * Cherche la dernière version publiée et met l'état à jour.
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<object>} état du service après la vérification
   */
  async function checkNow(options = {}) {
    if (!available) throw new ServiceError('unavailable', 'Les mises à jour ne sont pas disponibles dans cette exécution.');
    if (checking && !options.force) throw new ServiceError('busy', 'Une vérification est déjà en cours.');
    checking = true;
    progress = null;
    announce();
    try {
      const found = await fetchLatest();
      latest = found;
      lastError = null;
      // Un fichier déjà téléchargé pour une autre version n'est plus proposé.
      if (ready && ready.version !== found.version) {
        try {
          fs.rmSync(ready.file, { force: true });
        } catch {
          /* le fichier sera remplacé au prochain téléchargement */
        }
        ready = null;
      }
    } catch (error) {
      checking = false;
      lastError = error instanceof ServiceError ? { code: error.code, message: error.message } : { code: 'failed', message: 'La vérification a échoué.' };
      lastCheck = now();
      announce();
      throw error;
    }
    checking = false;
    lastCheck = now();
    announce();
    if (updateAvailable()) emit('available', latest);
    return state();
  }

  /** Annonce l'état courant. */
  const announce = () => emit('state', state());

  function state() {
    return {
      available,
      channel,
      currentVersion,
      updateAvailable: updateAvailable(),
      checking,
      downloading,
      progress: progress ? { ...progress } : null,
      ready: ready ? { ...ready } : null,
      latest: latest ? { ...latest } : null,
      lastCheck,
      lastError,
      checksumFile: CHECKSUM_ASSET,
      /** Page des versions, ouverte dans le navigateur du système à la demande. */
      releaseUrl: repo ? `https://github.com/${repo.owner}/${repo.name}/releases/latest` : null,
    };
  }

  /**
   * Demande réseau : adresse contrôlée, délai borné, réponse vérifiée.
   * @param {string} raw
   * @param {object} [options]
   * @param {string} [options.accept]
   * @param {boolean} [options.json]  la réponse est lue comme du JSON
   */
  async function request(raw, { accept = 'application/octet-stream' } = {}) {
    const url = allowedUrl(raw);
    if (!url) throw new ServiceError('forbidden-host', 'Adresse refusée : seules les adresses de GitHub sont contactées.');
    if (!fetcher) throw new ServiceError('unavailable', "La vérification des mises à jour n'est pas disponible.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url.href, {
        headers: { accept, 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (response.status === 403 || response.status === 429) {
        throw new ServiceError('rate-limited', 'Trop de demandes : réessayez dans quelques minutes.');
      }
      if (!response.ok) {
        throw new ServiceError('network', `Le serveur de mises à jour a répondu ${response.status}.`);
      }
      return response;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      clearTimeout(timer);
      if (error?.name === 'AbortError') throw new ServiceError('timeout', 'Le serveur de mises à jour ne répond pas.');
      throw new ServiceError('offline', "Impossible de joindre le serveur de mises à jour : vérifiez votre connexion.");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Dernière version publiée : description, ou `null` si aucune n'est publiée. */
  async function fetchLatest() {
    const response = await request(`https://api.github.com/repos/${repo.owner}/${repo.name}/releases/latest`, {
      accept: 'application/vnd.github+json',
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ServiceError('unexpected', 'La réponse du serveur est inattendue.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ServiceError('unexpected', 'La réponse du serveur est inattendue.');
    }
    if (data.message) throw new ServiceError('no-release', 'Aucune version publiée pour le moment.');
    const version = parseVersion(data.tag_name);
    if (!version) throw new ServiceError('unexpected', 'Le numéro de version publié est inattendu.');
    const name = assetNameFor(channel, version.text, assets);
    const asset = Array.isArray(data.assets)
      ? data.assets.find((item) => item && item.name === name && typeof item.browser_download_url === 'string')
      : undefined;
    if (!asset) {
      throw new ServiceError('no-asset', `Cette version ne contient pas de fichier pour cette installation (${name}).`);
    }
    return {
      version: version.text,
      tag: String(data.tag_name ?? version.text),
      notes: typeof data.body === 'string' ? data.body.trim() : '',
      publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
      url: typeof data.html_url === 'string' && allowedUrl(data.html_url) ? data.html_url : `https://github.com/${repo.owner}/${repo.name}/releases/latest`,
      asset: { name: asset.name, size: Number(asset.size) || 0, url: asset.browser_download_url },
      checksum: Array.isArray(data.assets)
        ? (data.assets.find((item) => item && item.name === CHECKSUM_ASSET && typeof item.browser_download_url === 'string')?.browser_download_url ?? null)
        : null,
    };
  }

  /** Itère sur les morceaux d'un corps de réponse (flux web ou flux Node). */
  async function* chunksOf(body) {
    if (!body) return;
    if (typeof body.getReader === 'function') {
      const stream = Readable.fromWeb(body);
      for await (const chunk of stream) yield chunk;
      return;
    }
    for await (const chunk of body) yield chunk;
  }

  /** Écrit le fichier téléchargé en calculant son empreinte ; annonce la progression. */
  async function writeAsset(asset, file) {
    const response = await request(asset.url);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > 0 && declared > maxBytes) {
      throw new ServiceError('too-large', 'Le fichier proposé est trop volumineux.');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const hash = createHash('sha256');
    let loaded = 0;
    let announcedAt = 0;
    const handle = fs.createWriteStream(file);
    try {
      for await (const chunk of chunksOf(response.body)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        loaded += buffer.length;
        if (loaded > maxBytes) throw new ServiceError('too-large', 'Le fichier proposé est trop volumineux.');
        hash.update(buffer);
        if (!handle.write(buffer)) await new Promise((resolve) => handle.once('drain', resolve));
        const stamp = Date.now();
        if (stamp - announcedAt >= PROGRESS_INTERVAL_MS) {
          announcedAt = stamp;
          progress = { loaded, total: Number.isFinite(declared) && declared > 0 ? declared : null };
          emit('progress', progress);
        }
      }
      await new Promise((resolve, reject) => {
        handle.end((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      handle.destroy();
      throw error instanceof ServiceError ? error : new ServiceError('download', "Le téléchargement a échoué.");
    }
    progress = { loaded, total: loaded };
    emit('progress', progress);
    return { sha256: hash.digest('hex'), size: loaded };
  }

  /** Empreinte publiée pour un fichier ; `null` si elle est absente. */
  async function publishedChecksum(url, name) {
    if (!url) return null;
    const response = await request(url);
    const text = await response.text();
    return checksumFor(text, name);
  }

  return {
    /** État courant : version disponible, téléchargement, progression, incidents. */
    state,

    /**
     * Cherche la dernière version publiée.
     * @param {object} [options]
     * @param {boolean} [options.force]  revérifie même si une vérification est en cours
     */
    async check(_context, options = {}) {
      return checkNow(options);
    },

    /** Télécharge la mise à jour et vérifie son empreinte avant de la proposer. */
    async download() {
      if (!available) throw new ServiceError('unavailable', "Les mises à jour ne sont pas disponibles dans cette exécution.");
      if (!latest) await checkNow({});
      if (!updateAvailable()) throw new ServiceError('no-update', 'Aucune mise à jour à télécharger.');
      if (downloading) throw new ServiceError('busy', 'Un téléchargement est déjà en cours.');
      if (ready && ready.version === latest.version) return ready;

      const asset = latest.asset;
      downloading = true;
      progress = { loaded: 0, total: asset.size || null };
      announce();
      const target = path.join(downloadDir, asset.name);
      const partial = `${target}.part`;
      let written;
      try {
        written = await writeAsset(asset, partial);
      } catch (error) {
        downloading = false;
        progress = null;
        lastError = error instanceof ServiceError ? { code: error.code, message: error.message } : { code: 'failed', message: 'Le téléchargement a échoué.' };
        announce();
        try {
          fs.rmSync(partial, { force: true });
        } catch {
          /* rien de plus à faire */
        }
        throw error;
      }

      let expected = null;
      try {
        expected = await publishedChecksum(latest.checksum, asset.name);
      } catch (error) {
        downloading = false;
        progress = null;
        lastError = { code: error.code ?? 'failed', message: error.message };
        try {
          fs.rmSync(partial, { force: true });
        } catch {
          /* rien de plus à faire */
        }
        announce();
        throw error;
      }

      if (!expected || expected !== written.sha256) {
        downloading = false;
        progress = null;
        lastError = {
          code: 'bad-checksum',
          message: expected
            ? "L'empreinte du fichier téléchargé ne correspond pas à celle publiée : la mise à jour n'est pas installée."
            : 'Aucune empreinte publiée pour ce fichier : la mise à jour n’est pas installée.',
        };
        try {
          fs.rmSync(partial, { force: true });
        } catch {
          /* rien de plus à faire */
        }
        announce();
        throw new ServiceError(lastError.code, lastError.message);
      }

      try {
        fs.rmSync(target, { force: true });
        fs.renameSync(partial, target);
      } catch (error) {
        downloading = false;
        progress = null;
        announce();
        throw new ServiceError('failed', `Le fichier téléchargé n'a pas pu être conservé : ${error?.message ?? error}`);
      }

      ready = { version: latest.version, file: target, size: written.size, sha256: written.sha256 };
      downloading = false;
      progress = null;
      lastError = null;
      announce();
      return { ...ready };
    },

    /** Lance l'installation de la mise à jour déjà téléchargée et vérifiée. */
    async install() {
      if (channel === 'portable') {
        throw new ServiceError(
          'portable',
          "La version portable ne se met pas à jour d'elle-même : téléchargez la nouvelle version depuis la page des versions.",
        );
      }
      if (!ready) throw new ServiceError('no-download', 'Aucune mise à jour téléchargée.');
      if (!fs.existsSync(ready.file)) {
        ready = null;
        announce();
        throw new ServiceError('no-download', 'Le fichier téléchargé a disparu : relancez le téléchargement.');
      }
      if (typeof launch !== 'function') throw new ServiceError('unavailable', "L'installation n'est pas disponible dans cette exécution.");
      const outcome = await launch(ready.file, { channel, version: ready.version });
      if (outcome && outcome.ok === false) throw new ServiceError(outcome.code ?? 'failed', outcome.message ?? "L'installation n'a pas pu être lancée.");
      return { launched: true, version: ready.version };
    },

    /** État du service, pour les comptes rendus. */
    status() {
      return {
        state: available ? 'available' : 'unavailable',
        channel,
        currentVersion,
        updateAvailable: updateAvailable(),
        hosts: [...HOSTS],
      };
    },

    /** Abonne `listener(event, payload, origin)` aux événements du service. */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = {
  createUpdatesService,
  CHANNELS,
  ASSET_TEMPLATES,
  CHECKSUM_ASSET,
  compareVersions,
  parseVersion,
  checksumFor,
  allowedUrl,
  assetNameFor,
};
