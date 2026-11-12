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
      app: 'monitor',
      title: 'Widgets matériels en mode démo',
      body: 'Les valeurs CPU, RAM et GPU affichées sont simulées. Les mesures réelles arriveront plus tard.',
      time: at(9),
    },
    {
      id: 'explorer',
      app: 'explorer',
      title: 'Explorateur : vos vrais fichiers',
      body: "Dans l'application Windows, l'explorateur agit sur vos vrais dossiers : rien n'est remplacé, et « supprimer » envoie à la Corbeille. Les fichiers recommandés du menu Démarrer restent fictifs.",
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
