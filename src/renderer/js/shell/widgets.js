/**
 * Evolve — Widgets du bureau : horloge/date et matériel (CPU, RAM, GPU).
 *
 * Les valeurs matérielles sont FICTIVES à cette étape : elles proviennent du
 * simulateur de démonstration et sont identifiées comme telles à l'écran.
 */

import { h } from '../core/dom.js';
import { onTick } from '../core/clock.js';
import { formatDayMonth, formatNumber, formatSeconds, formatTime } from '../core/format.js';
import { createHardwareSimulator } from '../data/demo-hardware.js';
import { createHardwareWidget } from '../widgets/hardware-widget.js';
import { TIMING } from '../config.js';
import { ui } from './ui-state.js';

/** Nombre de mesures simulées d'avance pour remplir les courbes d'historique. */
const HISTORY_LENGTH = 28;

export class Widgets {
  #timer = 0;
  #simulator = createHardwareSimulator();
  #cards;

  /** @param {HTMLElement} el */
  constructor(el) {
    this.el = el;

    // --- Horloge et date ---
    const time = h('span', { class: 'tabular' });
    const seconds = h('span', { class: 'clock-widget__seconds tabular' });
    const date = h('p', { class: 'clock-widget__date' });
    el.append(
      h(
        'section',
        { class: 'widget clock-widget glass', 'aria-label': 'Horloge et date', style: { '--i': '0' } },
        h('p', { class: 'clock-widget__time' }, time, seconds),
        date,
      ),
    );
    onTick((now) => {
      time.textContent = formatTime(now);
      seconds.textContent = formatSeconds(now);
      date.textContent = formatDayMonth(now);
    });

    // --- Matériel (données fictives) ---
    const interval = TIMING.hardwareTick;
    // Quelques mesures simulées d'avance : les courbes sont tracées dès l'affichage.
    const history = Array.from({ length: HISTORY_LENGTH }, () => this.#simulator.next());
    const past = (metric) => history.map((sample) => sample[metric].load);
    this.#cards = {
      cpu: createHardwareWidget({ id: 'cpu', title: 'Processeur', glyph: 'cpu', interval, index: 1, history: past('cpu') }),
      ram: createHardwareWidget({ id: 'ram', title: 'Mémoire', glyph: 'memory', interval, index: 2, history: past('ram') }),
      gpu: createHardwareWidget({
        id: 'gpu',
        title: 'Carte graphique',
        glyph: 'graphics-card',
        interval,
        index: 3,
        history: past('gpu'),
      }),
    };
    el.append(this.#cards.cpu.el, this.#cards.ram.el, this.#cards.gpu.el);

    ui.subscribe('widgetsVisible', (visible) => {
      el.classList.toggle('is-hidden', !visible);
      el.inert = !visible;
      this.#setRunning(visible);
    });

    // Inutile d'animer quand la fenêtre de l'application n'est pas visible.
    document.addEventListener('visibilitychange', () => {
      this.#setRunning(ui.get('widgetsVisible') && !document.hidden);
    });
  }

  #setRunning(running) {
    clearInterval(this.#timer);
    this.#timer = 0;
    if (!running) return;
    this.#update();
    this.#timer = setInterval(() => this.#update(), TIMING.hardwareTick);
  }

  #update() {
    const { cpu, ram, gpu } = this.#simulator.next();
    this.#cards.cpu.update({
      load: cpu.load,
      primary: `${formatNumber(cpu.ghz, 2)} GHz`,
      secondary: `${cpu.cores} cœurs · ${Math.round(cpu.temp)} °C`,
    });
    this.#cards.ram.update({
      load: ram.load,
      primary: `${formatNumber(ram.usedGb, 1)} / ${formatNumber(ram.totalGb, 0)} Go`,
      secondary: `${formatNumber(ram.totalGb - ram.usedGb, 1)} Go disponibles`,
    });
    this.#cards.gpu.update({
      load: gpu.load,
      primary: `${Math.round(gpu.temp)} °C`,
      secondary: `VRAM ${formatNumber(gpu.vramUsedGb, 1)} / ${formatNumber(gpu.vramTotalGb, 0)} Go`,
    });
  }
}
