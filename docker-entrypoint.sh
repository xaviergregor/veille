#!/bin/sh
# Le dossier ./data de l'hôte appartient à l'utilisateur qui a décompressé le projet :
# on le confie à l'utilisateur « node » du conteneur, puis on lâche les droits root.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  find "$DATA_DIR" \! -user node -exec chown node:node {} + 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
