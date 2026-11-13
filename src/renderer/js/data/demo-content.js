/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  CONTENU D'EXEMPLE — DÉMONSTRATION UNIQUEMENT                        ║
 * ║  Notifications affichées dans le centre de notifications.            ║
 * ║  Elles décrivent honnêtement l'état de cette version d'Evolve.       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const MINUTE = 60_000;

/** Teinte des notifications émises par Evolve lui-même. */
const EVOLVE_COLORS = ['#e2c6ff', '#7c3aed'];

/**
 * Notifications d'exemple.
 * `app` renvoie à une application disponible du registre (icône + nom) ; à
 * défaut, `glyph` / `colors` / `source` décrivent l'émetteur. Aucune
 * notification ne prétend venir d'une application qui n'existe pas encore.
 * @param {Date} [now]
 */
export function createDemoNotifications(now = new Date()) {
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * MINUTE);
  return [
    {
      id: 'welcome',
      source: 'Evolve',
      glyph: 'planet',
      colors: EVOLVE_COLORS,
      title: 'Bienvenue dans Evolve',
      body: "Le bureau, les fenêtres et l'explorateur de fichiers fonctionnent réellement. Les autres applications sont annoncées, mais pas encore disponibles.",
      time: at(1),
    },
    {
      id: 'windows',
      source: 'Evolve',
      glyph: 'app-window',
      colors: EVOLVE_COLORS,
      title: 'Plusieurs fenêtres à la fois',
      body: "Ctrl + Tab passe d'une fenêtre à l'autre. Glissez une fenêtre vers un bord de l'écran pour qu'elle en occupe la moitié, vers le haut pour l'agrandir.",
      time: at(5),
    },
    {
      id: 'explorer',
      app: 'explorer',
      title: 'Explorateur : vos vrais fichiers',
      body: "Dans l'application Windows, l'explorateur agit sur vos vrais dossiers : rien n'est remplacé, et « supprimer » envoie à la Corbeille de Windows.",
      time: at(27),
    },
    {
      id: 'widgets',
      source: 'Evolve',
      glyph: 'pulse',
      colors: EVOLVE_COLORS,
      title: 'Widgets matériels en mode démo',
      body: 'Les valeurs CPU, RAM et GPU affichées sont simulées, et signalées par la mention « DÉMO ».',
      time: at(42),
    },
    {
      id: 'settings',
      source: 'Evolve',
      glyph: 'gear-six',
      colors: EVOLVE_COLORS,
      title: 'Réglages visuels uniquement',
      body: "Les paramètres rapides n'agissent que sur l'interface. Aucun paramètre Windows n'est modifié.",
      time: at(64),
    },
  ];
}
