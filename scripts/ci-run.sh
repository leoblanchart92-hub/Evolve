#!/usr/bin/env bash
# Evolve — Exécute une étape de la compilation automatique (GitHub Actions).
#
# La sortie de la commande est affichée normalement et copiée dans un journal
# (ci-logs/NOM.log). Si la commande échoue, la fin de ce journal est publiée
# sous forme d'annotation : la cause de l'échec apparaît directement sur la
# page de l'exécution, sans ouvrir les journaux détaillés.
#
# Si la commande était une série de tests (node --test), son bilan est publié
# lui aussi, qu'elle ait réussi ou non : nombre de tests réussis sur cette
# machine, et nom de ceux qui n'y ont pas été exécutés.
#
# Utilisation : bash scripts/ci-run.sh NOM COMMANDE [ARGUMENTS…]
#   NOM   nom court de l'étape, sans espace (exemple : tests-automatiques)

set -u -o pipefail

if [ "$#" -lt 2 ]; then
  echo "Utilisation : bash scripts/ci-run.sh NOM COMMANDE [ARGUMENTS…]" >&2
  exit 2
fi

name="$1"
shift

log_dir="${CI_LOG_DIR:-ci-logs}"
log="${log_dir}/${name}.log"
mkdir -p "$log_dir"

"$@" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"

if [ "$status" -ne 0 ]; then
  node "$(dirname "$0")/ci-annotate.mjs" "$log" "$name" || true
fi
node "$(dirname "$0")/ci-annotate.mjs" --tests "$log" || true

exit "$status"
