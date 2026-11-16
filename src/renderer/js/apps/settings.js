/**
 * Evolve — Paramètres.
 *
 * Fenêtre de réglages d'Evolve : informations sur l'application, bureau,
 * réseau et son (réglages visuels, retenus d'un lancement à l'autre), mises à
 * jour et remise à zéro.
 *
 * Les réglages affichés ici sont ceux que l'interface applique réellement :
 * chaque commande agit sur l'état partagé (shell/ui-state.js), que la
 * synchronisation enregistre dans le fichier des réglages. Aucun paramètre de
 * Windows n'est lu ni modifié.
 */

import { h } from '../core/dom.js';
import { formatSize } from '../core/format.js';
import { icon, setIcon } from '../core/icons.js';
import { openExternal } from '../core/platform.js';
import { services } from '../core/services.js';
import { ui, volumeGlyph } from '../shell/ui-state.js';
import { PRODUCT } from '../config.js';

/** Pages du panneau, dans l'ordre de la colonne de gauche. */
const PAGES = Object.freeze([
  { id: 'system', label: 'Système', glyph: 'desktop' },
  { id: 'display', label: 'Bureau', glyph: 'squares-four' },
  { id: 'network', label: 'Réseau et son', glyph: 'wifi-high' },
  { id: 'updates', label: 'Mises à jour', glyph: 'arrows-clockwise' },
  { id: 'reset', label: 'Réinitialiser', glyph: 'arrow-clockwise' },
]);

/**
 * Monte l'application Paramètres dans une fenêtre.
 * @param {object} win      fenêtre (voir wm/window.js)
 * @param {object} [params] `{ page }` : page ouverte d'emblée
 * @param {object} [shell]  environnement (notifications éphémères)
 */
export function mountSettings(win, params, shell) {
  const cleanups = [];
  const root = h('div', { class: 'settings' });
  const nav = h('nav', { class: 'settings__nav scroll', role: 'tablist', 'aria-label': 'Sections' });
  const main = h('div', { class: 'settings__main scroll' });
  root.append(nav, main);

  const pages = new Map();
  let current = PAGES.find((page) => page.id === params?.page)?.id ?? PAGES[0].id;

  /** Affiche une page ; son contenu n'est construit qu'à la première visite. */
  function show(id) {
    current = PAGES.some((page) => page.id === id) ? id : PAGES[0].id;
    if (!pages.has(current)) {
      const build = BUILDERS[current];
      pages.set(current, build ? build({ shell, cleanups }) : { el: h('div') });
    }
    const page = pages.get(current);
    main.replaceChildren(page.el);
    main.scrollTop = 0;
    for (const button of nav.children) {
      const active = button.dataset.page === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    page.refresh?.();
  }

  for (const page of PAGES) {
    const button = h(
      'button',
      { class: 'settings__tab', type: 'button', role: 'tab', dataset: { page: page.id } },
      icon(page.glyph),
      h('span', { class: 'truncate', text: page.label }),
    );
    button.addEventListener('click', () => show(page.id));
    nav.append(button);
  }

  win.body.append(root);
  show(current);

  return {
    /** Ouvre une page demandée alors que la fenêtre est déjà ouverte. */
    onParams(next) {
      if (next?.page && next.page !== current) show(next.page);
    },
    destroy() {
      for (const stop of cleanups.splice(0)) stop();
    },
  };
}

// --- Éléments d'interface réutilisables ------------------------------------------

/** En-tête de page : titre et sous-titre. */
function heading(title, subtitle) {
  return h('header', { class: 'settings__head' }, h('h2', { text: title }), subtitle ? h('p', { text: subtitle }) : null);
}

/** Bloc (carte) d'une page. */
function card(...children) {
  return h('section', { class: 'settings__card' }, ...children);
}

/** Ligne : libellé à gauche, commande à droite. */
function row(title, control, hint) {
  return h(
    'div',
    { class: 'settings__row' },
    h(
      'span',
      { class: 'settings__row-text' },
      h('span', { class: 'settings__row-title', text: title }),
      hint ? h('span', { class: 'settings__row-hint', text: hint }) : null,
    ),
    control,
  );
}

/**
 * Interrupteur.
 * @param {object} options
 * @param {() => boolean} options.get
 * @param {(value: boolean) => void} options.set
 * @param {(fn: () => void) => () => void} [options.subscribe]  synchronisation
 *        avec une source extérieure (état partagé, service, fichier)
 * @param {string} [options.label]
 * @returns {{ el: HTMLElement, stop: (() => void)|null }}
 */
function toggle({ get, set, subscribe, label }) {
  const el = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(Boolean(get())),
    'aria-label': label,
  });
  const sync = () => el.setAttribute('aria-checked', String(Boolean(get())));
  el.addEventListener('click', () => set(!get()));
  return { el, stop: subscribe?.(sync) ?? null };
}

/** Interrupteur branché sur l'état partagé (enregistré d'un lancement à l'autre). */
function uiToggle(key, title, hint, { cleanups }) {
  const control = toggle({
    label: title,
    get: () => Boolean(ui.get(key)),
    set: (value) => ui.set(key, value),
    subscribe: (fn) => ui.subscribe(key, fn),
  });
  if (control.stop) cleanups.push(control.stop);
  return row(title, control.el, hint);
}

/** Curseur branché sur l'état partagé. */
function uiSlider(key, title, { min, max, glyph }) {
  const input = h('input', {
    class: 'slider',
    type: 'range',
    min: String(min),
    max: String(max),
    value: String(ui.get(key)),
    'aria-label': title,
  });
  const value = h('span', { class: 'settings__value tabular' });
  const picture = glyph ? icon(glyph(), 'fill') : null;
  const sync = () => {
    const current = ui.get(key);
    const muted = key === 'volume' && ui.get('muted');
    const level = muted ? 0 : current;
    if (Number(input.value) !== current) input.value = String(current);
    input.style.setProperty('--pct', `${((level - min) / (100 - min)) * 100}%`);
    input.setAttribute('aria-valuetext', muted ? 'Son coupé' : `${current} %`);
    value.textContent = muted ? 'Muet' : `${current} %`;
    if (picture && glyph) setIcon(picture, glyph(), 'fill');
  };
  input.addEventListener('input', () => {
    ui.set(key, Number(input.value));
    // Déplacer le curseur du volume réactive le son, comme dans le panneau.
    if (key === 'volume' && ui.get('muted')) ui.set('muted', false);
  });
  const stops = [ui.subscribe(key, sync)];
  // Le son coupé change l'apparence du curseur de volume.
  if (key === 'volume') stops.push(ui.subscribe('muted', sync, { immediate: false }));
  return { el: row(title, h('span', { class: 'settings__slider' }, picture, input, value)), stops };
}

/** Message d'information (note de bas de page). */
function note(glyph, text, chip) {
  return h('p', { class: 'settings__note' }, icon(glyph), h('span', { text }), chip ? h('span', { class: 'chip chip--demo', text: chip }) : null);
}

/** Valeur affichée pour une donnée de texte (jamais vide). */
const shown = (text, fallback = '—') => (text ? String(text) : fallback);

// --- Pages -----------------------------------------------------------------------

/**
 * Système : ce qu'Evolve sait de lui-même (service « system »).
 * Les informations sont demandées à l'application de bureau ; dans l'aperçu
 * navigateur, elles sont annoncées indisponibles.
 */
function systemPage() {
  const el = h('div', { class: 'settings__page' });
  const about = h('div', { class: 'settings__about' });
  const list = h('div', { class: 'settings__card' });
  el.append(heading('Système', "Ce qu'Evolve sait de son exécution, sans rien modifier à votre ordinateur."), about, list);

  let loaded = false;

  /** Ligne d'information, avec un bouton d'ouverture si le dossier existe. */
  function detail(title, value, target, folder) {
    const button = folder
      ? h('button', { class: 'btn btn--ghost', type: 'button', 'aria-label': `Ouvrir le dossier : ${title}` }, 'Ouvrir', icon('arrow-square-out'))
      : null;
    if (button) {
      button.addEventListener('click', () => {
        services.call('system', 'open', target).catch(() => {});
      });
    }
    return row(title, button ?? h('span', { class: 'settings__value truncate', title: value, text: value }));
  }

  async function refresh() {
    if (loaded || !services.available) return;
    let info;
    try {
      info = await services.call('system', 'info');
    } catch {
      return;
    }
    if (!info || typeof info !== 'object') return;
    loaded = true;

    about.replaceChildren(
      h('span', { class: 'app-icon app-icon--lg', style: { '--g1': '#d3b0ff', '--g2': '#7c3aed' } }, icon('planet', 'fill')),
      h(
        'span',
        { class: 'settings__about-text' },
        h('span', { class: 'settings__about-name', text: shown(info.app, PRODUCT.name) }),
        h(
          'span',
          { class: 'settings__about-meta' },
          h('span', { class: 'tabular', text: `Version ${shown(info.version)}` }),
          h('span', { class: 'chip', text: PRODUCT.stage }),
        ),
        h('span', { class: 'settings__about-meta', text: shown(info.install?.label) }),
      ),
    );

    const paths = info.paths ?? {};
    list.replaceChildren(
      detail('Installation', shown(info.install?.dir), 'install', paths.install),
      detail('Réglages', shown(paths.settings, 'Aucun fichier (réglages en mémoire)'), 'settings', paths.settings),
      detail('Données de travail', shown(paths.data), 'data', paths.data),
      detail('Système', `${shown(info.platform?.name)} · ${shown(info.platform?.arch)} · ${shown(info.platform?.release)}`),
      detail('Moteur', `Electron ${shown(info.versions?.electron)} · Chromium ${shown(info.versions?.chrome)} · Node ${shown(info.versions?.node)}`),
    );
  }

  return { el, refresh };
}

/** Bureau : widgets, icônes, luminosité et éclairage nocturne. */
function displayPage({ cleanups }) {
  const brightness = uiSlider('brightness', 'Luminosité', { min: 20, max: 100, glyph: () => (ui.get('brightness') < 55 ? 'sun-dim' : 'sun') });
  cleanups.push(...brightness.stops);
  return {
    el: h(
      'div',
      { class: 'settings__page' },
      heading('Bureau', "L'apparence de l'environnement, retenue d'un lancement à l'autre."),
      card(
        uiToggle('widgetsVisible', 'Widgets', 'Horloge, processeur, mémoire et carte graphique', { cleanups }),
        uiToggle('desktopIconsVisible', 'Icônes du bureau', null, { cleanups }),
        brightness.el,
        uiToggle('nightLight', 'Éclairage nocturne', 'Teinte l’écran d’Evolve, comme le ferait Windows', { cleanups }),
      ),
      note('info', "Ces réglages n'agissent que sur l'interface d'Evolve : aucun paramètre d'affichage de Windows n'est modifié.", 'Visuel'),
    ),
  };
}

/** Réseau et son : les paramètres rapides, retenus mais purement visuels. */
function networkPage({ cleanups }) {
  const volume = uiSlider('volume', 'Volume', { min: 0, max: 100, glyph: () => volumeGlyph(ui.get('volume'), ui.get('muted')) });
  cleanups.push(...volume.stops);
  return {
    el: h(
      'div',
      { class: 'settings__page' },
      heading('Réseau et son', 'Les mêmes commandes que le panneau des paramètres rapides.'),
      card(
        uiToggle('wifi', 'Wi-Fi', null, { cleanups }),
        uiToggle('bluetooth', 'Bluetooth', null, { cleanups }),
        uiToggle('airplane', 'Mode avion', 'Coupe le Wi-Fi et le Bluetooth de l’interface', { cleanups }),
        uiToggle('energySaver', 'Économie d’énergie', null, { cleanups }),
        uiToggle('doNotDisturb', 'Ne pas déranger', null, { cleanups }),
        volume.el,
        uiToggle('muted', 'Couper le son', null, { cleanups }),
      ),
      note('info', "Ces commandes sont des interrupteurs d'interface : Evolve ne touche ni à votre Wi-Fi, ni à votre carte réseau, ni au volume de Windows.", 'Visuel'),
    ),
  };
}

/**
 * Mises à jour : recherche, téléchargement vérifié puis installation.
 * Rien n'est jamais installé sans un clic de l'utilisateur.
 */
function updatesPage({ shell, cleanups }) {
  let state = null;
  let busy = false;

  const versionLine = h('p', { class: 'settings__status settings__status--muted' });
  const statusLine = h('p', { class: 'settings__status' });
  const progress = h('div', { class: 'settings__progress', hidden: true }, h('span', { class: 'settings__progress-bar' }));
  const progressText = h('span', { class: 'settings__value tabular' });
  const errorText = h('span');
  const error = h('p', { class: 'settings__error', hidden: true }, icon('warning-circle'), errorText);
  const detail = h('div', { class: 'settings__update' });
  const actions = h('div', { class: 'settings__actions' });

  // Le réglage « vérifier au démarrage » est conservé comme les autres : il
  // passe par l'état de l'interface, que la synchronisation enregistre.
  const autoCheck = uiToggle('updatesAutoCheck', 'Vérifier au démarrage', 'Une seule consultation par lancement', { cleanups });

  const checkButton = h('button', { class: 'btn btn--accent', type: 'button' }, 'Vérifier maintenant', icon('arrows-clockwise'));
  checkButton.addEventListener('click', () => run(() => services.call('updates', 'check', {})));

  const el = h(
    'div',
    { class: 'settings__page' },
    heading('Mises à jour', 'Evolve consulte la dernière version publiée sur GitHub, et ne fait rien d’autre de lui-même.'),
    card(
      versionLine,
      statusLine,
      progress,
      progressText,
      error,
      autoCheck,
      actions,
    ),
    detail,
    note('lock', "Une mise à jour n'est installée que si son empreinte correspond à celle publiée avec elle."),
  );

  /** Exécute une commande du service en gardant l'interface cohérente. */
  async function run(command) {
    if (busy) return;
    busy = true;
    error.hidden = true;
    render();
    try {
      await command();
    } catch (failure) {
      errorText.textContent = failure?.message ?? "L'opération a échoué.";
      error.hidden = false;
    } finally {
      busy = false;
      await refresh();
    }
  }

  /** Met l'interface en accord avec l'état du service. */
  function render() {
    const available = state?.available === true;
    checkButton.disabled = busy || !available || state?.checking === true;
    actions.replaceChildren();

    if (!available) {
      statusLine.textContent = services.available
        ? 'Les mises à jour ne sont pas disponibles dans cette exécution.'
        : "Les mises à jour ne sont pas disponibles dans l'aperçu navigateur.";
      versionLine.textContent = `Version installée : ${shown(state?.currentVersion ?? PRODUCT.version)}`;
      return;
    }

    if (state.checking) statusLine.textContent = 'Recherche de la dernière version…';
    else if (state.downloading) statusLine.textContent = 'Téléchargement en cours…';
    else if (state.updateAvailable) statusLine.textContent = `Version ${state.latest.version} disponible.`;
    else if (state.lastError) statusLine.textContent = 'La dernière vérification a échoué.';
    else statusLine.textContent = state.latest ? 'Evolve est à jour.' : 'Aucune vérification effectuée pour le moment.';

    if (state.updateAvailable && state.latest) {
      if (state.channel === 'portable') {
        actions.append(
          button('Télécharger la nouvelle version', 'arrow-square-out', true, () => openExternal(state.releaseUrl ?? state.latest.url)),
        );
      } else if (state.ready) {
        actions.append(
          button('Installer et redémarrer', 'download-simple', true, () =>
            run(async () => {
              await services.call('updates', 'install');
              shell?.toasts?.show({
                key: 'updates-install',
                title: 'Installation lancée',
                message: "Evolve se ferme pour laisser l'installation s'achever.",
                glyph: 'download-simple',
                colors: ['#8fd8ff', '#6557f5'],
                timeout: 6000,
              });
            }),
          ),
        );
      } else {
        actions.append(
          button('Télécharger la mise à jour', 'download-simple', true, () => run(() => services.call('updates', 'download'))),
        );
      }
      actions.append(button('Voir les nouveautés', 'arrow-square-out', false, () => openExternal(state.latest.url)));
    }
    actions.append(checkButton);

    detail.replaceChildren();
    if (state.updateAvailable && state.latest) {
      const notes = state.latest.notes?.trim();
      detail.append(
        card(
          h(
            'header',
            { class: 'settings__card-head' },
            h('span', { class: 'settings__row-title', text: `Version ${state.latest.version}` }),
            h('span', { class: 'chip chip--accent', text: state.ready ? 'Téléchargée' : 'Disponible' }),
          ),
          h(
            'p',
            {
              class: 'settings__row-hint',
              text: `Publiée le ${shown(state.latest.publishedAt?.slice(0, 10), 'date inconnue')} · ${formatSize(state.latest.asset?.size || 0)}`,
            },
          ),
          notes ? h('pre', { class: 'settings__notes scroll', text: notes }) : null,
        ),
      );
    }
  }

  /** Bouton d'action : `accent` pour l'action principale. */
  function button(label, glyph, accent, onClick) {
    const el = h('button', { class: `btn ${accent ? 'btn--accent' : 'btn--ghost'}`, type: 'button' }, label, icon(glyph));
    el.addEventListener('click', onClick);
    return el;
  }

  async function refresh() {
    try {
      state = await services.call('updates', 'state');
    } catch {
      state = { available: false };
    }
    versionLine.textContent = state?.lastCheck
      ? `Version installée : ${shown(state.currentVersion ?? PRODUCT.version)} · vérifié à ${new Date(state.lastCheck).toLocaleTimeString('fr-FR')}`
      : `Version installée : ${shown(state?.currentVersion ?? PRODUCT.version)}`;
    render();
  }

  // Suivi des événements du service.
  cleanups.push(
    services.on('updates', 'state', (payload) => {
      state = payload ?? state;
      render();
    }),
    services.on('updates', 'progress', (payload) => {
      const total = payload?.total ?? 0;
      const loaded = payload?.loaded ?? 0;
      progress.hidden = false;
      progress.firstElementChild.style.width = total ? `${Math.min(100, Math.round((loaded / total) * 100))}%` : '100%';
      progressText.textContent = total ? `${formatSize(loaded)} sur ${formatSize(total)}` : formatSize(loaded);
    }),
  );

  return { el, refresh };
}

/** Réinitialiser : revenir aux réglages d'origine. */
function resetPage({ shell }) {
  const button = h('button', { class: 'btn btn--accent', type: 'button' }, 'Rétablir les réglages d’origine', icon('arrow-clockwise'));
  button.addEventListener('click', async () => {
    try {
      await services.call('settings', 'reset');
      shell?.toasts?.show({
        key: 'settings-reset',
        title: 'Réglages rétablis',
        message: 'Les valeurs d’origine sont de retour ; le fichier des réglages a été vidé.',
        glyph: 'arrow-clockwise',
        colors: ['#b4b4dc', '#51409c'],
        timeout: 6000,
      });
    } catch {
      /* l'interface reste utilisable : rien de plus à signaler */
    }
  });

  return {
    el: h(
      'div',
      { class: 'settings__page' },
      heading('Réinitialiser', 'Revenir aux réglages d’origine sans rien supprimer d’autre.'),
      card(
        row('Rétablir les réglages', button, 'Widgets, icônes du bureau, paramètres rapides'),
        note('info', 'Pour repartir de zéro, fermez Evolve puis supprimez le dossier %APPDATA%\\Evolve : c’est le seul endroit où vos réglages sont rangés.'),
      ),
      card(
        h('h3', { class: 'settings__row-title', text: 'Désinstaller Evolve' }),
        h('p', {
          class: 'settings__row-hint',
          text: 'S’il a été installé : Paramètres Windows, Applications, Evolve, Désinstaller. La version portable s’enlève en supprimant son fichier .exe : aucun raccourci ni dossier n’est laissé ailleurs.',
        }),
      ),
    ),
  };
}

const BUILDERS = Object.freeze({
  system: systemPage,
  display: displayPage,
  network: networkPage,
  updates: updatesPage,
  reset: resetPage,
});
