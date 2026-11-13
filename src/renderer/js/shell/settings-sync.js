/**
 * Evolve — Réglages conservés d'un lancement à l'autre.
 *
 * Relie l'état de l'interface (ui-state.js) au service des réglages :
 *   - au démarrage, les valeurs enregistrées sont appliquées avant que le
 *     bureau ne soit construit : il apparaît tel qu'il a été laissé ;
 *   - ensuite, chaque changement fait dans l'interface est transmis au
 *     service, qui l'enregistre.
 *
 * Dans l'aperçu navigateur, le service n'existe pas : rien n'est conservé.
 */

import { services } from '../core/services.js';
import { ui } from './ui-state.js';

/** Réglages conservés : clé de l'état de l'interface, puis nom du réglage. */
export const PERSISTED = Object.freeze({
  widgetsVisible: 'desktop.widgetsVisible',
  desktopIconsVisible: 'desktop.iconsVisible',
  wifi: 'quick.wifi',
  bluetooth: 'quick.bluetooth',
  airplane: 'quick.airplane',
  energySaver: 'quick.energySaver',
  nightLight: 'quick.nightLight',
  doNotDisturb: 'quick.doNotDisturb',
  brightness: 'quick.brightness',
  volume: 'quick.volume',
  muted: 'quick.muted',
  // Emplacement de la fenêtre de l'explorateur (voir window-placement.js).
  explorerWindowX: 'explorerWindow.x',
  explorerWindowY: 'explorerWindow.y',
  explorerWindowWidth: 'explorerWindow.width',
  explorerWindowHeight: 'explorerWindow.height',
  explorerWindowMaximized: 'explorerWindow.maximized',
});

/** Attente maximale des réglages au démarrage : au-delà, le bureau s'ouvre sans eux. */
const LOAD_TIMEOUT_MS = 1500;

const NOTICE_COLORS = ['#ffd27a', '#f97316'];

/** Message affiché quand les réglages ne peuvent pas être enregistrés. */
export const UNSAVED_NOTICE = Object.freeze({
  key: 'settings-unsaved',
  title: 'Réglages non enregistrés',
  message: "Le fichier des réglages est inaccessible : vos changements risquent d'être perdus à la fermeture.",
  glyph: 'warning-circle',
  colors: NOTICE_COLORS,
  timeout: 9000,
});

/** Message affiché quand le fichier des réglages était inutilisable au démarrage. */
export const RESET_NOTICE = Object.freeze({
  key: 'settings-reset',
  title: 'Réglages réinitialisés',
  message: 'Le fichier des réglages était illisible : une copie a été mise de côté.',
  glyph: 'warning-circle',
  colors: NOTICE_COLORS,
  timeout: 9000,
});

/**
 * Démarre la synchronisation des réglages.
 *
 * @param {object} [options]
 * @param {object} [options.store]    état de l'interface (voir core/events.js)
 * @param {object} [options.client]   accès aux services (voir core/services.js)
 * @param {number} [options.timeout]  attente maximale du chargement, en millisecondes
 * @param {(message: string) => void} [options.report]  journal des incidents
 * @returns {{ ready: Promise<boolean>, onNotice: (show: (notice: object) => void) => void }}
 *   `ready` : vrai une fois les réglages enregistrés appliqués, faux s'ils
 *   n'ont pas pu l'être à temps (elle ne rejette jamais) ;
 *   `onNotice` : reçoit les messages destinés à l'utilisateur (incidents
 *   d'enregistrement), y compris ceux survenus avant l'appel.
 */
export function startSettingsSync({ store = ui, client = services, timeout = LOAD_TIMEOUT_MS, report = (message) => console.warn(message) } = {}) {
  if (!client.available) return { ready: Promise.resolve(false), onNotice() {} };

  const settingOf = new Map(Object.entries(PERSISTED));
  const keyOf = new Map(Object.entries(PERSISTED).map(([key, setting]) => [setting, key]));

  /** Réglages déjà modifiés par l'utilisateur : ils priment sur un chargement tardif. */
  const touched = new Set();
  /** Vrai pendant l'application de valeurs venues du service (à ne pas lui renvoyer). */
  let applying = false;

  const apply = (values, { external = false } = {}) => {
    applying = true;
    try {
      for (const [setting, value] of Object.entries(values ?? {})) {
        const key = keyOf.get(setting);
        if (!key || (!external && touched.has(key))) continue;
        // Une valeur d'une autre nature que celle attendue n'entre jamais dans l'interface.
        if (typeof value === typeof store.get(key) && !Number.isNaN(value)) store.set(key, value);
      }
    } finally {
      applying = false;
    }
  };

  // --- Messages à l'utilisateur ----------------------------------------------
  const waiting = [];
  let show = null;
  let resetTold = false;
  let problemTold = null;

  const tell = (notice) => {
    if (show) show(notice);
    else waiting.push(notice);
  };

  const onState = (state) => {
    if (state?.recovered === 'corrupt' && !resetTold) {
      resetTold = true;
      tell(RESET_NOTICE);
    }
    const problem = state?.problem ?? null;
    if (problem === problemTold) return;
    problemTold = problem;
    if (problem) tell(UNSAVED_NOTICE);
  };

  // --- Interface vers service --------------------------------------------------
  store.subscribe('*', ({ key, value }) => {
    if (applying || !settingOf.has(key)) return;
    touched.add(key);
    client.call('settings', 'set', settingOf.get(key), value).catch((error) => {
      report(`Réglage « ${key} » non transmis : ${error?.message ?? error}`);
    });
  });

  // --- Service vers interface --------------------------------------------------
  try {
    client.on('settings', 'changed', (change) => apply({ [change?.key]: change?.value }, { external: true }));
    client.on('settings', 'state', onState);
  } catch (error) {
    report(`Réglages : événements du service indisponibles : ${error?.message ?? error}`);
  }

  const loaded = client.call('settings', 'getAll').then(
    (values) => {
      apply(values);
      return true;
    },
    (error) => {
      report(`Réglages non chargés : ${error?.message ?? error}`);
      return false;
    },
  );
  client.call('settings', 'state').then(onState, () => {});

  const ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    loaded.then((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });

  return {
    ready,
    onNotice(listener) {
      show = listener;
      while (waiting.length) listener(waiting.shift());
    },
  };
}
