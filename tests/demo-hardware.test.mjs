/**
 * Simulateur des mesures matérielles (widgets CPU / RAM / GPU).
 * Ces valeurs sont FICTIVES : les tests vérifient qu'elles restent plausibles
 * et qu'elles sont toujours signalées comme données de démonstration.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHardwareSimulator, DEMO_MACHINE } from '../src/renderer/js/data/demo-hardware.js';

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('la machine et chaque mesure sont marquées comme démonstration', () => {
  assert.equal(DEMO_MACHINE.isDemo, true);
  const simulator = createHardwareSimulator({ random: seeded(1) });
  assert.equal(simulator.snapshot().isDemo, true);
  for (let i = 0; i < 50; i += 1) assert.equal(simulator.next().isDemo, true);
});

test('les valeurs restent plausibles sur une longue durée', () => {
  for (const seed of [1, 7, 42, 2026, 987654]) {
    const simulator = createHardwareSimulator({ random: seeded(seed) });
    for (let i = 0; i < 4000; i += 1) {
      const { cpu, ram, gpu } = simulator.next();

      assert.ok(cpu.load >= 2 && cpu.load <= 99, `charge CPU ${cpu.load}`);
      assert.ok(cpu.ghz >= 2.4 && cpu.ghz <= 4.7, `fréquence CPU ${cpu.ghz}`);
      assert.ok(cpu.temp >= 37 && cpu.temp <= 81, `température CPU ${cpu.temp}`);
      assert.equal(cpu.cores, DEMO_MACHINE.cpu.cores);

      assert.ok(ram.load >= 20 && ram.load <= 95, `charge RAM ${ram.load}`);
      assert.equal(ram.totalGb, DEMO_MACHINE.ram.totalGb);
      assert.ok(ram.usedGb > 0 && ram.usedGb < ram.totalGb, `RAM utilisée ${ram.usedGb}`);
      assert.ok(Math.abs(ram.usedGb / ram.totalGb - ram.load / 100) < 1e-9, 'RAM utilisée cohérente avec la charge');

      assert.ok(gpu.load >= 1 && gpu.load <= 99, `charge GPU ${gpu.load}`);
      assert.ok(gpu.temp >= 35 && gpu.temp <= 81, `température GPU ${gpu.temp}`);
      assert.equal(gpu.vramTotalGb, DEMO_MACHINE.gpu.vramGb);
      assert.ok(gpu.vramUsedGb > 0 && gpu.vramUsedGb < gpu.vramTotalGb, `VRAM utilisée ${gpu.vramUsedGb}`);
    }
  }
});

test('les valeurs varient dans le temps (les widgets sont vivants)', () => {
  const simulator = createHardwareSimulator({ random: seeded(3) });
  const loads = Array.from({ length: 300 }, () => simulator.next().cpu.load);
  const spread = Math.max(...loads) - Math.min(...loads);
  assert.ok(spread > 15, `amplitude CPU trop faible : ${spread}`);
  assert.ok(new Set(loads.map((value) => value.toFixed(3))).size > 250, 'les valeurs successives doivent différer');
});

test('la charge évolue progressivement, sans saut brutal', () => {
  const simulator = createHardwareSimulator({ random: seeded(11) });
  let previous = simulator.snapshot();
  for (let i = 0; i < 2000; i += 1) {
    const current = simulator.next();
    assert.ok(Math.abs(current.cpu.load - previous.cpu.load) < 40, 'saut CPU trop brutal');
    assert.ok(Math.abs(current.ram.load - previous.ram.load) < 8, 'saut RAM trop brutal');
    assert.ok(Math.abs(current.gpu.load - previous.gpu.load) < 32, 'saut GPU trop brutal');
    previous = current;
  }
});

test('à générateur identique, simulation identique', () => {
  const a = createHardwareSimulator({ random: seeded(5) });
  const b = createHardwareSimulator({ random: seeded(5) });
  for (let i = 0; i < 100; i += 1) assert.deepEqual(a.next(), b.next());
});

test('snapshot() relit les dernières valeurs sans faire avancer la simulation', () => {
  const simulator = createHardwareSimulator({ random: seeded(9) });
  const next = simulator.next();
  assert.deepEqual(simulator.snapshot(), next);
  assert.deepEqual(simulator.snapshot(), next);
});
