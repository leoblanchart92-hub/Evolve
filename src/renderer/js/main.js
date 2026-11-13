/**
 * Evolve — Point d'entrée de l'interface.
 * Construit l'environnement de bureau puis retire l'écran de démarrage.
 */

import { PRODUCT, TIMING } from './config.js';
import { wait } from './core/dom.js';
import { installIcons } from './core/icons.js';
import { startSettingsSync } from './shell/settings-sync.js';
import { Shell } from './shell/shell.js';

const boot = document.getElementById('boot');

/** Délai maximal avant le retrait de l'écran de démarrage (son fondu dure 620 ms). */
const BOOT_REMOVAL_MS = 2000;

/** Attend que le fond d'écran et les polices soient prêts (sans jamais bloquer). */
async function assetsReady() {
  const wallpaper = document.getElementById('wallpaper');
  const decoded = wallpaper?.decode ? wallpaper.decode().catch(() => {}) : Promise.resolve();
  const fonts = document.fonts?.ready ?? Promise.resolve();
  await Promise.race([Promise.all([decoded, fonts]), wait(4000)]);
}

function showBootError(error) {
  console.error(error);
  if (!boot) return;
  boot.classList.add('has-error');
  const message = document.createElement('p');
  message.className = 'boot__error';
  message.textContent = `L'interface n'a pas pu démarrer : ${error?.message ?? error}`;
  boot.querySelector('.boot__inner')?.append(message);
}

async function start() {
  const startedAt = performance.now();
  installIcons();

  // Les réglages enregistrés sont appliqués avant de construire le bureau : il
  // apparaît directement tel qu'il a été laissé. L'attente est bornée et
  // masquée par l'écran de démarrage.
  const settings = startSettingsSync();
  await settings.ready;

  const shell = new Shell();

  await assetsReady();
  await wait(Math.max(0, TIMING.bootMin - (performance.now() - startedAt)));

  // Révèle le bureau : les animations d'entrée démarrent à cet instant.
  document.documentElement.classList.add('is-ready');
  boot?.classList.add('is-done');
  boot?.addEventListener('transitionend', (event) => {
    if (event.target === boot && event.propertyName === 'opacity') boot.remove();
  });
  // Garde-fou : si la transition ne se joue pas (fenêtre masquée), l'écran est tout de même retiré.
  setTimeout(() => boot?.remove(), BOOT_REMOVAL_MS);

  await wait(1400);
  shell.toasts.show({
    key: 'welcome',
    title: `Bienvenue dans ${PRODUCT.name}`,
    message: "Ouvrez l'explorateur depuis le bureau ou le menu Démarrer. Ctrl + Tab passe d'une fenêtre à l'autre.",
    glyph: 'planet',
    colors: ['#e2c6ff', '#7c3aed'],
    timeout: 6500,
  });

  // Incident d'enregistrement des réglages : l'utilisateur en est informé.
  settings.onNotice((notice) => shell.toasts.show(notice));
}

start().catch(showBootError);
