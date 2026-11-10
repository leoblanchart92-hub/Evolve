'use strict';

/**
 * Evolve — Auto-test : les réglages survivent à un redémarrage.
 *
 * Deux scénarios, exécutés par deux lancements successifs de l'application
 * sur le même dossier de réglages (voir scripts/check-settings.mjs) :
 *
 *   settings-write   part des valeurs par défaut, modifie des réglages comme
 *                    le ferait l'utilisateur (clics, curseurs), puis quitte ;
 *   settings-read    vérifie, sans aucune action, que l'interface affiche les
 *                    réglages laissés par le lancement précédent.
 *
 * Entre les deux, le script lit lui-même le fichier des réglages : la preuve
 * ne repose pas sur ce que l'application dit d'elle-même.
 */

const { SETTINGS, defaultsOf } = require('../services/settings-schema');

/** Réglages modifiés par le premier lancement et attendus au second. */
const CHANGED_SETTINGS = Object.freeze({
  'desktop.widgetsVisible': false,
  'quick.nightLight': true,
  'quick.doNotDisturb': true,
  'quick.brightness': 60,
  'quick.volume': 35,
});

/** Valeur de tous les réglages après les modifications. */
const EXPECTED_SETTINGS = Object.freeze({ ...defaultsOf(SETTINGS), ...CHANGED_SETTINGS });

/**
 * Code exécuté dans la page : `shown()` relève ce que l'interface affiche
 * pour les réglages modifiés ; `same(a, b)` compare deux relevés.
 */
const PAGE_TOOLS = `
  const shown = () => {
    const tile = (id) => document.querySelector('.qs-tile[data-setting="' + id + '"]').getAttribute('aria-pressed') === 'true';
    const slider = (id) => Number(document.querySelector('.qs-slider[data-setting="' + id + '"] input').value);
    return {
      'desktop.widgetsVisible': !document.querySelector('.widgets').classList.contains('is-hidden'),
      'quick.nightLight': tile('nightLight'),
      'quick.doNotDisturb': tile('doNotDisturb'),
      'quick.brightness': slider('brightness'),
      'quick.volume': slider('volume'),
    };
  };
  const same = (actual, expected) => Object.keys(expected).every((key) => actual[key] === expected[key]);
`;

/** Code exécuté dans la page : règle un curseur comme le ferait un glissement. */
const moveSlider = (id, value) => `{
  const input = document.querySelector('.qs-slider[data-setting="${id}"] input');
  input.value = '${value}';
  input.dispatchEvent(new Event('input', { bubbles: true }));
}`;

/** Code exécuté dans la page : le service enregistre réellement dans un fichier, sans incident. */
const STORAGE_OK = `
  const state = await window.evolve.services.call('settings', 'state');
  return (state.ok === true && state.value.storage === 'file' && state.value.durable === true
    && state.value.problem === null && state.value.recovered === null) || state;`;

/**
 * @param {object} tools  outils de l'auto-test (voir selftest.js)
 * @returns {Record<string, () => Promise<void>>} scénarios, par nom
 */
function settingsScenarios({ begin, check, act, capture }) {
  const defaults = JSON.stringify(Object.fromEntries(Object.keys(CHANGED_SETTINGS).map((key) => [key, SETTINGS[key].default])));
  const changed = JSON.stringify(CHANGED_SETTINGS);
  const expected = JSON.stringify(EXPECTED_SETTINGS);

  return {
    'settings-write': async () => {
      if (!(await begin())) return;

      await check(
        'premier lancement : chaque réglage a sa valeur par défaut',
        `${PAGE_TOOLS} const state = shown(); return same(state, ${defaults}) || state;`,
      );
      await check('les réglages sont enregistrés dans un fichier', STORAGE_OK);

      // Les mêmes gestes que l'utilisateur : bouton des widgets, tuiles, curseurs.
      await act(`document.querySelector('.tb-widgets').click();`);
      await act(`document.querySelector('.tb-tray').click();`);
      await check("le panneau des paramètres rapides s'ouvre", `return document.querySelector('.qs').classList.contains('is-open');`);
      await act(`document.querySelector('.qs-tile[data-setting="nightLight"]').click();`);
      await act(`document.querySelector('.qs-tile[data-setting="doNotDisturb"]').click();`);
      await act(moveSlider('brightness', CHANGED_SETTINGS['quick.brightness']));
      await act(moveSlider('volume', CHANGED_SETTINGS['quick.volume']));

      await check(
        "l'interface affiche les réglages modifiés",
        `${PAGE_TOOLS} const state = shown(); return same(state, ${changed}) || state;`,
      );
      await check(
        'le service des réglages a reçu chaque changement',
        `${PAGE_TOOLS}
         const reply = await window.evolve.services.call('settings', 'getAll');
         return (reply.ok === true && same(reply.value, ${expected})) || reply;`,
      );
      await capture('01-reglages-modifies');
    },

    'settings-read': async () => {
      if (!(await begin())) return;

      await check(
        "nouveau lancement : l'interface affiche les réglages enregistrés, sans aucune action",
        `${PAGE_TOOLS} const state = shown(); return same(state, ${changed}) || state;`,
      );
      await check(
        'leurs effets sont appliqués : teinte nocturne, luminosité réduite, widgets masqués',
        `const night = document.querySelector('.screen-fx__night').classList.contains('is-on');
         const dim = Number(document.querySelector('.screen-fx__dim').style.opacity);
         const widgets = document.querySelector('.tb-widgets').getAttribute('aria-pressed');
         return (night && dim > 0.2 && widgets === 'false') || { night, dim, widgets };`,
      );
      await check(
        'le service des réglages restitue les valeurs enregistrées',
        `${PAGE_TOOLS}
         const reply = await window.evolve.services.call('settings', 'getAll');
         return (reply.ok === true && same(reply.value, ${expected})) || reply;`,
      );
      await check('le fichier des réglages a été relu sans incident', STORAGE_OK);

      await act(`document.querySelector('.tb-tray').click();`);
      await check("le panneau des paramètres rapides s'ouvre", `return document.querySelector('.qs').classList.contains('is-open');`);
      await capture('01-reglages-restaures');
    },
  };
}

module.exports = { settingsScenarios, CHANGED_SETTINGS, EXPECTED_SETTINGS };
