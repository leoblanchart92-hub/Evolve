'use strict';

/**
 * Evolve — Définition des réglages.
 *
 * Chaque réglage a un nom stable, un type, une valeur par défaut et, pour un
 * nombre, des bornes. Toute valeur lue dans le fichier ou reçue de
 * l'interface est contrôlée ici avant d'être utilisée.
 *
 * Faire évoluer cette liste :
 *   - ajouter un réglage : une ligne ci-dessous suffit (les fichiers existants
 *     restent valables, le nouveau réglage y prend sa valeur par défaut) ;
 *   - renommer un réglage ou en changer le sens : augmenter SCHEMA_VERSION et
 *     ajouter la conversion dans MIGRATIONS. Un nom n'est JAMAIS réutilisé
 *     avec un autre sens : une ancienne version d'Evolve qui rencontre un
 *     fichier plus récent ne risque ainsi jamais de mal l'interpréter.
 */

/** Version du format du fichier des réglages. */
const SCHEMA_VERSION = 1;

const SETTINGS = Object.freeze({
  // Bureau
  'desktop.widgetsVisible': { type: 'boolean', default: true },
  'desktop.iconsVisible': { type: 'boolean', default: true },

  // Panneau des paramètres rapides (réglages de l'interface d'Evolve : aucun
  // n'agit encore sur le système)
  'quick.wifi': { type: 'boolean', default: true },
  'quick.bluetooth': { type: 'boolean', default: true },
  'quick.airplane': { type: 'boolean', default: false },
  'quick.energySaver': { type: 'boolean', default: false },
  'quick.nightLight': { type: 'boolean', default: false },
  'quick.doNotDisturb': { type: 'boolean', default: false },
  'quick.brightness': { type: 'integer', default: 100, min: 20, max: 100 },
  'quick.volume': { type: 'integer', default: 64, min: 0, max: 100 },
  'quick.muted': { type: 'boolean', default: false },
});

/**
 * Conversions d'un format au suivant : `MIGRATIONS[n]` reçoit les valeurs
 * d'un fichier au format `n` et renvoie celles du format `n + 1`.
 * Aucune pour l'instant : le format 1 est le premier.
 */
const MIGRATIONS = Object.freeze({});

/**
 * Contrôle une valeur. Un nombre hors bornes est ramené dans les bornes ;
 * une valeur d'un autre type est refusée.
 * @returns {{ ok: true, value: any } | { ok: false }}
 */
function normalize(definition, value) {
  if (!definition) return { ok: false };
  if (definition.type === 'boolean') return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
  if (definition.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false };
    return { ok: true, value: Math.min(definition.max, Math.max(definition.min, Math.round(value))) };
  }
  return { ok: false };
}

/** Valeurs par défaut de tous les réglages de `definitions`. */
function defaultsOf(definitions = SETTINGS) {
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [key, definition.default]));
}

module.exports = { SCHEMA_VERSION, SETTINGS, MIGRATIONS, normalize, defaultsOf };
