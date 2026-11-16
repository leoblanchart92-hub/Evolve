/**
 * Service du système (src/services/system.js) : des mesures réelles, lues à
 * la demande — et `null` quand une mesure n'existe pas, jamais une valeur
 * inventée.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import { test } from 'node:test';

import { readText, stripComments } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createSystemService, MIN_INTERVAL_MS, PROCESS_LABELS } = require('../src/services/system.js');

/** Faux système : compteurs de chaque cœur réglables, mémoire et durée fixées. */
function fakeOs({ cores = 4 } = {}) {
  const counters = Array.from({ length: cores }, () => ({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }));
  return {
    counters,
    /** Fait passer `busy` ms d'activité et `idle` ms d'inactivité sur un cœur. */
    spend(core, busy, idle) {
      counters[core].user += busy * 0.75;
      counters[core].sys += busy * 0.25;
      counters[core].idle += idle;
    },
    module: {
      cpus: () => counters.map((times) => ({ model: '  Processeur   d’essai  ', speed: 3200, times: { ...times } })),
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 6 * 1024 ** 3,
      uptime: () => 93784.5,
      platform: () => 'win32',
      version: () => 'Windows 11 Pro',
      release: () => '10.0.22631',
      arch: () => 'x64',
    },
  };
}

test('charge du processeur : déduite des compteurs entre deux lectures ; inconnue à la première', () => {
  const machine = fakeOs({ cores: 4 });
  let time = 1_000_000;
  const service = createSystemService({ os: machine.module, now: () => time });

  // Première lecture : aucune charge ne peut être calculée — elle n'est pas inventée.
  const first = service.sample();
  assert.deepEqual(first.cpu, { load: null, cores: [] });
  assert.deepEqual(first.memory, { total: 16 * 1024 ** 3, free: 6 * 1024 ** 3 });
  assert.equal(first.uptime, 93784.5);
  assert.equal(first.at, new Date(time).toISOString());
  assert.equal(first.evolve, null, 'sans hôte, aucun processus d’Evolve n’est décrit');

  // Une seconde plus tard : cœur 0 occupé à 100 %, cœur 1 à 50 %, cœur 2 à 25 %, cœur 3 inactif.
  machine.spend(0, 1000, 0);
  machine.spend(1, 500, 500);
  machine.spend(2, 250, 750);
  machine.spend(3, 0, 1000);
  time += 1000;
  assert.deepEqual(service.sample().cpu, { load: 0.4375, cores: [1, 0.5, 0.25, 0] });

  // Chaque lecture porte sur l'intervalle écoulé depuis la précédente, pas sur le total depuis le démarrage.
  for (let core = 0; core < 4; core += 1) machine.spend(core, 100, 900);
  time += 1000;
  const third = service.sample().cpu;
  assert.ok(Math.abs(third.load - 0.1) < 1e-9);
  assert.ok(third.cores.every((value) => Math.abs(value - 0.1) < 1e-9));
});

test('charge du processeur : deux lectures trop rapprochées donnent la même mesure', () => {
  const machine = fakeOs({ cores: 2 });
  let time = 0;
  const service = createSystemService({ os: machine.module, now: () => time });
  service.sample();
  machine.spend(0, 750, 250);
  machine.spend(1, 250, 750);
  time = 1000;
  const measured = service.sample().cpu;
  assert.deepEqual(measured, { load: 0.5, cores: [0.75, 0.25] });
  // 100 ms plus tard, avec très peu de temps écoulé sur les compteurs : la mesure précédente est rendue.
  machine.spend(0, 100, 0);
  time = 1000 + MIN_INTERVAL_MS - 1;
  assert.deepEqual(service.sample().cpu, measured);
  // Passé l'écart minimal, une nouvelle mesure couvre tout l'intervalle depuis la dernière lecture retenue.
  machine.spend(0, 150, 0);
  machine.spend(1, 0, 250);
  time = 1000 + MIN_INTERVAL_MS;
  assert.deepEqual(service.sample().cpu, { load: 0.5, cores: [1, 0] });
  assert.equal(MIN_INTERVAL_MS, 250);
});

test('mesures incohérentes ou absentes : `null`, jamais une valeur de remplacement', () => {
  let time = 0;
  // Un système qui ne répond pas.
  const silent = createSystemService({
    os: {
      cpus: () => {
        throw new Error('indisponible');
      },
      totalmem: () => Number.NaN,
      freemem: () => -1,
      uptime: () => {
        throw new Error('indisponible');
      },
      platform: () => 'win32',
      version: () => '',
      release: () => undefined,
      arch: () => 'x64',
    },
    now: () => (time += 1000),
  });
  silent.sample();
  assert.deepEqual({ ...silent.sample(), at: '' }, { at: '', uptime: null, cpu: { load: null, cores: [] }, memory: { total: null, free: null }, evolve: null });
  assert.deepEqual(silent.overview().cpu, { model: null, cores: null, speedMHz: null });
  assert.deepEqual(silent.overview().system, { platform: 'win32', name: null, release: null, arch: 'x64' });

  // Des compteurs qui reculent (mise en veille, cœur retiré) : la charge de ce cœur est inconnue.
  const machine = fakeOs({ cores: 2 });
  const service = createSystemService({ os: machine.module, now: () => (time += 1000) });
  machine.spend(0, 500, 500);
  machine.spend(1, 500, 500);
  service.sample();
  machine.counters[0].idle -= 100;
  machine.spend(1, 250, 750);
  assert.deepEqual(service.sample().cpu, { load: 0.25, cores: [null, 0.25] });
  // Un nombre de cœurs qui change entre deux lectures : aucune comparaison possible.
  machine.counters.push({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
  assert.deepEqual(service.sample().cpu, { load: null, cores: [] });
  // Plus de mémoire libre que de mémoire installée : la valeur est écartée.
  const odd = createSystemService({ os: { ...machine.module, freemem: () => 32 * 1024 ** 3 } });
  assert.deepEqual(odd.sample().memory, { total: 16 * 1024 ** 3, free: null });
});

test('aperçu : ce que le système dit de lui-même, et ce que l’hôte dit d’Evolve', () => {
  const machine = fakeOs({ cores: 8 });
  const service = createSystemService({
    os: machine.module,
    appVersion: '0.6.0',
    variant: 'installed',
    dataDir: 'C:\\Users\\Léa\\AppData\\Roaming\\Evolve',
    versions: { electron: '45.2.3', chromium: ' 146.0.1 ', node: '24.1.0', 'nom invalide !': 'x', vide: '', nombre: 12 },
  });
  assert.deepEqual(service.overview(), {
    system: { platform: 'win32', name: 'Windows 11 Pro', release: '10.0.22631', arch: 'x64' },
    cpu: { model: 'Processeur d’essai', cores: 8, speedMHz: 3200 },
    memory: { total: 16 * 1024 ** 3 },
    evolve: { version: '0.6.0', variant: 'installed', dataDir: 'C:\\Users\\Léa\\AppData\\Roaming\\Evolve', versions: { electron: '45.2.3', chromium: '146.0.1', node: '24.1.0' } },
  });
  assert.deepEqual(service.status(), { access: 'read-only', measures: 'real', processes: false });
  // Sans rien de fourni : les champs d'Evolve sont vides, pas inventés.
  assert.deepEqual(createSystemService({ os: machine.module }).overview().evolve, { version: null, variant: 'development', dataDir: null, versions: {} });
});

test('processus d’Evolve : fournis par l’hôte, ramenés à une part de l’ensemble du processeur', () => {
  const machine = fakeOs({ cores: 4 });
  let time = 0;
  let list = [
    { type: 'Browser', name: null, pid: 100, cpu: 40, memory: 120 * 1024 ** 2 },
    { type: 'Tab', name: null, pid: 101, cpu: 100, memory: 300 * 1024 ** 2 },
    { type: 'GPU', name: null, pid: 102, cpu: 0, memory: 80 * 1024 ** 2 },
    { type: 'Utility', name: 'Network Service', pid: 103, cpu: 4, memory: 30 * 1024 ** 2 },
    { type: 'Utility', name: 'Un service inconnu', pid: 104, cpu: null, memory: null },
    { type: 'Nature inconnue', pid: -5, cpu: -1, memory: Number.NaN },
    {},
  ];
  const service = createSystemService({ os: machine.module, now: () => (time += 1000), processes: () => list });
  service.sample();
  const { evolve } = service.sample();
  assert.deepEqual(evolve.processes, [
    { pid: 100, label: 'Processus principal', cpu: 0.1, memory: 120 * 1024 ** 2 },
    { pid: 101, label: 'Interface', cpu: 0.25, memory: 300 * 1024 ** 2 },
    { pid: 102, label: 'Affichage', cpu: 0, memory: 80 * 1024 ** 2 },
    { pid: 103, label: 'Service : Réseau', cpu: 0.01, memory: 30 * 1024 ** 2 },
    { pid: 104, label: 'Service : Un service inconnu', cpu: null, memory: null },
    { pid: null, label: 'Nature inconnue', cpu: null, memory: null },
    { pid: null, label: 'Processus', cpu: null, memory: null },
  ]);
  // Quatre cœurs : 144 % d'un cœur font 36 % de l'ensemble.
  assert.ok(Math.abs(evolve.cpu - 0.36) < 1e-9);
  assert.equal(evolve.memory, 530 * 1024 ** 2);
  assert.equal(service.status().processes, true);
  assert.equal(PROCESS_LABELS.Browser, 'Processus principal');

  // Un hôte en erreur, ou qui répond autre chose qu'une liste : aucun processus n'est décrit.
  list = null;
  assert.equal(service.sample().evolve, null);
  const failing = createSystemService({ os: machine.module, processes: () => { throw new Error('indisponible'); } });
  assert.equal(failing.sample().evolve, null);
  // Une liste démesurée est bornée.
  list = Array.from({ length: 500 }, (_, index) => ({ type: 'Tab', pid: index + 1, cpu: 1, memory: 1 }));
  assert.equal(service.sample().evolve.processes.length, 64);
});

test('sur cette machine : de vraies mesures, plausibles', async () => {
  const service = createSystemService({ appVersion: '0.6.0' });
  const overview = service.overview();
  assert.equal(overview.system.platform, process.platform);
  assert.equal(overview.cpu.cores, os.cpus().length);
  assert.equal(overview.memory.total, os.totalmem());
  service.sample();
  // Un peu de calcul, pour que les compteurs avancent.
  const until = Date.now() + 300;
  let spins = 0;
  while (Date.now() < until) spins += Math.sqrt(spins + 1) > 0 ? 1 : 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const sample = service.sample();
  assert.equal(sample.cpu.cores.length, os.cpus().length);
  assert.ok(sample.cpu.load > 0 && sample.cpu.load <= 1, `charge mesurée : ${sample.cpu.load}`);
  assert.ok(sample.memory.free > 0 && sample.memory.free <= sample.memory.total);
  assert.ok(sample.uptime > 0);
});

test('le service du système ne fait que lire : aucun autre module que celui du système, aucune écriture', () => {
  const code = stripComments(readText('src/services/system.js'));
  assert.deepEqual([...code.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]), ['node:os']);
  // Les seules fonctions du système employées : des lectures.
  const used = [...new Set([...code.matchAll(/\bos\.(\w+)\(/g)].map((match) => match[1]))].sort();
  assert.deepEqual(used, ['arch', 'cpus', 'freemem', 'platform', 'release', 'totalmem', 'uptime', 'version']);
  assert.doesNotMatch(code, /\bsetPriority\b|\bprocess\.(?:kill|exit|chdir|env)\b|Math\.random/);
});
