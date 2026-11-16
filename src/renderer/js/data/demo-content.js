/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  CONTENU D'EXEMPLE — DÉMONSTRATION UNIQUEMENT                        ║
 * ║  Notifications affichées dans le centre de notifications.            ║
 * ║  Elles décrivent honnêtement l'état de cet aperçu de l'interface.    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const MINUTE = 60_000;

/**
 * Notifications d'exemple.
 * `app` renvoie à une application du registre (icône + nom) ; à défaut,
 * `glyph` / `colors` / `source` décrivent l'émetteur.
 * @param {Date} [now]
 */
export function createDemoNotifications(now = new Date()) {
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * MINUTE);
  return [
    {
      id: 'welcome',
      source: 'Evolve',
      glyph: 'planet',
      colors: ['#e2c6ff', '#7c3aed'],
      title: 'Bienvenue dans Evolve',
      body: "Vous utilisez un aperçu de l'interface graphique : bureau, fenêtres, menus et animations.",
      time: at(1),
    },
    {
      id: 'widgets',
      source: 'Widgets',
      glyph: 'pulse',
      colors: ['#eaa8ff', '#7a38ea'],
      title: 'Widgets matériels en mode démo',
      body: 'Les valeurs CPU, RAM et GPU affichées sont simulées. Les mesures réelles arriveront plus tard.',
      time: at(9),
    },
    {
      id: 'updates',
      source: 'Mises à jour',
      glyph: 'arrows-clockwise',
      colors: ['#8fd8ff', '#6557f5'],
      title: 'Evolve sait se mettre à jour',
      body: "Paramètres, page Mises à jour : elle indique si une version plus récente est publiée, et l'installe.",
      time: at(18),
    },
    {
      id: 'explorer',
      app: 'explorer',
      title: 'Explorateur en lecture seule',
      body: "Dans l'application Windows, l'explorateur affiche vos vrais dossiers sans rien modifier. Les fichiers recommandés du menu Démarrer restent fictifs.",
      time: at(27),
    },
    {
      id: 'settings',
      app: 'settings',
      title: 'Réglages visuels uniquement',
      body: "Les paramètres rapides n'agissent que sur l'interface. Aucun paramètre Windows n'est modifié.",
      time: at(64),
    },
  ];
}
