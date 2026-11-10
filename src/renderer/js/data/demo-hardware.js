/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  DONNÉES FICTIVES — DÉMONSTRATION UNIQUEMENT                         ║
 * ║  Ce module SIMULE des mesures matérielles (CPU, RAM, GPU) pour       ║
 * ║  animer les widgets. Aucune lecture réelle du matériel n'est faite.  ║
 * ║  Les vraies mesures seront branchées dans une prochaine étape.       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Caractéristiques fictives de la machine de démonstration. */
export const DEMO_MACHINE = Object.freeze({
  isDemo: true,
  cpu: Object.freeze({ cores: 8, threads: 16 }),
  ram: Object.freeze({ totalGb: 16 }),
  gpu: Object.freeze({ vramGb: 8 }),
});

/**
 * Crée un simulateur de charge : marche aléatoire amortie, avec des pics
 * d'activité occasionnels pour un rendu vivant et crédible.
 *
 * @param {{ random?: () => number }} [options]  générateur aléatoire injectable (tests)
 */
export function createHardwareSimulator({ random = Math.random } = {}) {
  const level = { cpu: 24, ram: 54, gpu: 30 };
  const target = { cpu: 24, ram: 54, gpu: 30 };

  const approach = (value, goal, inertia, jitter) =>
    value + (goal - value) * inertia + (random() - 0.5) * jitter;

  function snapshot() {
    const { cpu, ram, gpu } = level;
    return {
      isDemo: true,
      cpu: {
        load: cpu,
        ghz: 2.4 + (cpu / 100) * 2.3,
        temp: 37 + cpu * 0.44,
        cores: DEMO_MACHINE.cpu.cores,
        threads: DEMO_MACHINE.cpu.threads,
      },
      ram: {
        load: ram,
        usedGb: (ram / 100) * DEMO_MACHINE.ram.totalGb,
        totalGb: DEMO_MACHINE.ram.totalGb,
      },
      gpu: {
        load: gpu,
        temp: 35 + gpu * 0.46,
        vramUsedGb: 1.1 + (gpu / 100) * 5.4,
        vramTotalGb: DEMO_MACHINE.gpu.vramGb,
      },
    };
  }

  /** Avance la simulation d'un pas et renvoie les nouvelles valeurs. */
  function next() {
    if (random() < 0.2) target.cpu = 6 + random() * (random() < 0.25 ? 84 : 40);
    if (random() < 0.14) target.gpu = 8 + random() * (random() < 0.2 ? 78 : 42);
    if (random() < 0.07) target.ram = 44 + random() * 24;

    level.cpu = clamp(approach(level.cpu, target.cpu, 0.36, 7), 2, 99);
    level.gpu = clamp(approach(level.gpu, target.gpu, 0.3, 5), 1, 99);
    level.ram = clamp(approach(level.ram, target.ram, 0.12, 0.9), 20, 95);
    return snapshot();
  }

  return { next, snapshot };
}
