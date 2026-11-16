'use strict';

/**
 * Evolve — Service du système : ce que la machine dit d'elle-même.
 *
 * Des mesures réelles, lues à l'instant où elles sont demandées, et jamais
 * simulées : charge du processeur (déduite des compteurs de temps de chaque
 * cœur entre deux lectures), mémoire, durée de fonctionnement. Quand une
 * mesure n'existe pas — la charge avant la deuxième lecture, les processus
 * d'Evolve hors de l'application de bureau —, elle vaut `null` : rien n'est
 * inventé pour la remplacer.
 *
 * Lecture seule : ce service ne modifie rien, ni sur la machine, ni dans
 * Windows. L'espace des disques est fourni par le service de consultation
 * des fichiers (files.js).
 */

const nodeOs = require('node:os');

/** Écart minimal entre deux lectures des compteurs du processeur, en millisecondes. */
const MIN_INTERVAL_MS = 250;

/** Nombre maximal de processus d'Evolve décrits. */
const MAX_PROCESSES = 64;

/** Nature d'un processus d'Evolve, telle que l'hôte la nomme, et son nom affiché. */
const PROCESS_LABELS = Object.freeze({
  Browser: 'Processus principal',
  Tab: 'Interface',
  GPU: 'Affichage',
  Utility: 'Service',
  Zygote: 'Lanceur de processus',
  'Sandbox helper': 'Bac à sable',
});

/** Nom affiché des services du moteur les plus courants. */
const SERVICE_LABELS = Object.freeze({
  'Network Service': 'Réseau',
  'Audio Service': 'Son',
  'Storage Service': 'Stockage',
  'Video Capture': 'Capture vidéo',
});

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const shortText = (value, max = 120) => (typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : null);

/**
 * @param {object} [options]
 * @param {object} [options.os]   module du système (remplacé par les tests)
 * @param {() => number} [options.now]
 * @param {string|null} [options.appVersion]  version d'Evolve
 * @param {string} [options.variant]          façon dont Evolve a été lancé (voir updates.js)
 * @param {string|null} [options.dataDir]     dossier des réglages, des notes et de l'agenda
 * @param {Record<string, string>} [options.versions]  versions des composants de l'hôte, par nom
 * @param {(() => object[])|null} [options.processes]  processus d'Evolve, fournis par l'hôte :
 *        `{ type, name, pid, cpu, memory }` — `cpu` en pourcentage d'un cœur, `memory` en octets
 */
function createSystemService({ os = nodeOs, now = () => Date.now(), appVersion = null, variant = 'development', dataDir = null, versions = {}, processes = null } = {}) {
  /** Dernière lecture des compteurs du processeur : instant, et temps de chaque cœur. */
  let previous = null;
  /** Dernière charge calculée : d'ensemble, puis cœur par cœur. */
  let lastLoad = { load: null, cores: [] };

  /** Compteurs de chaque cœur : temps d'inactivité et temps total, en millisecondes. */
  function readCounters() {
    const list = os.cpus();
    if (!Array.isArray(list)) return [];
    return list.map((cpu) => {
      const times = cpu?.times ?? {};
      const total = ['user', 'nice', 'sys', 'idle', 'irq'].reduce((sum, key) => sum + (Number(times[key]) || 0), 0);
      return { idle: Number(times.idle) || 0, total };
    });
  }

  /** Charge entre deux lectures : part du temps où le processeur n'était pas inactif, de 0 à 1. */
  function loadBetween(before, after) {
    if (before.length === 0 || before.length !== after.length) return { load: null, cores: [] };
    let idle = 0;
    let total = 0;
    const cores = after.map((counter, index) => {
      const deltaTotal = counter.total - before[index].total;
      const deltaIdle = counter.idle - before[index].idle;
      if (!(deltaTotal > 0) || deltaIdle < 0) return null;
      idle += deltaIdle;
      total += deltaTotal;
      return Math.min(1, Math.max(0, 1 - deltaIdle / deltaTotal));
    });
    return { load: total > 0 ? Math.min(1, Math.max(0, 1 - idle / total)) : null, cores };
  }

  function cpuLoad() {
    const at = now();
    if (previous !== null && at - previous.at < MIN_INTERVAL_MS && at >= previous.at) return lastLoad;
    let counters = [];
    try {
      counters = readCounters();
    } catch {
      counters = [];
    }
    lastLoad = previous === null ? { load: null, cores: [] } : loadBetween(previous.counters, counters);
    previous = { at, counters };
    return lastLoad;
  }

  /** Processus d'Evolve, ou `null` si l'hôte ne les fournit pas. */
  function evolveProcesses(coreCount) {
    if (typeof processes !== 'function') return null;
    let list;
    try {
      list = processes();
    } catch {
      return null;
    }
    if (!Array.isArray(list)) return null;
    const cores = Math.max(1, coreCount);
    const described = list.slice(0, MAX_PROCESSES).map((item) => {
      const type = shortText(item?.type, 40);
      const name = shortText(item?.name, 80);
      const base = (type !== null && Object.hasOwn(PROCESS_LABELS, type) ? PROCESS_LABELS[type] : null) ?? type ?? 'Processus';
      const detail = type === 'Utility' && name !== null ? (Object.hasOwn(SERVICE_LABELS, name) ? SERVICE_LABELS[name] : name) : null;
      const percent = finite(item?.cpu);
      return {
        pid: Number.isInteger(item?.pid) && item.pid > 0 ? item.pid : null,
        label: detail ? `${base} : ${detail}` : base,
        // Part de l'ensemble du processeur : l'hôte compte en pourcentage d'un seul cœur.
        cpu: percent === null ? null : Math.min(1, percent / 100 / cores),
        memory: finite(item?.memory),
      };
    });
    const sum = (key) => (described.some((item) => item[key] !== null) ? described.reduce((total, item) => total + (item[key] ?? 0), 0) : null);
    const cpu = sum('cpu');
    return { processes: described, cpu: cpu === null ? null : Math.min(1, cpu), memory: sum('memory') };
  }

  const safe = (read, fallback = null) => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };

  return {
    // --- Méthodes publiques (appelables par l'interface) -----------------------

    /** Ce qui ne change pas pendant la session : système, processeur, mémoire installée, Evolve. */
    overview() {
      const cpus = safe(() => os.cpus(), []) ?? [];
      const shown = {};
      for (const [name, value] of Object.entries(versions ?? {}).slice(0, 12)) {
        const text = shortText(value, 40);
        if (text !== null && /^[a-z][a-z0-9-]{0,20}$/i.test(name)) shown[name] = text;
      }
      return {
        system: {
          platform: safe(() => os.platform()),
          name: shortText(safe(() => os.version())),
          release: shortText(safe(() => os.release()), 60),
          arch: shortText(safe(() => os.arch()), 20),
        },
        cpu: {
          model: shortText(cpus[0]?.model),
          cores: cpus.length || null,
          speedMHz: finite(cpus[0]?.speed) || null,
        },
        memory: { total: finite(safe(() => os.totalmem())) },
        evolve: { version: shortText(appVersion, 40), variant, dataDir: shortText(dataDir, 400), versions: shown },
      };
    },

    /** Mesures de l'instant. `cpu.load` vaut `null` à la première lecture : il faut deux lectures pour une charge. */
    sample() {
      const { load, cores } = cpuLoad();
      const total = finite(safe(() => os.totalmem()));
      const free = finite(safe(() => os.freemem()));
      return {
        at: new Date(now()).toISOString(),
        uptime: finite(safe(() => os.uptime())),
        cpu: { load, cores: [...cores] },
        memory: { total, free: total !== null && free !== null && free <= total ? free : null },
        evolve: evolveProcesses(cores.length || (previous?.counters.length ?? 0)),
      };
    },

    // --- Usage interne (jamais exposé à l'interface) ---------------------------

    /** État détaillé, pour les comptes rendus et les vérifications automatiques. */
    status() {
      return { access: 'read-only', measures: 'real', processes: typeof processes === 'function' };
    },
  };
}

module.exports = { createSystemService, MIN_INTERVAL_MS, PROCESS_LABELS };
