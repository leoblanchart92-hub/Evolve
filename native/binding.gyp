# Evolve — Module natif « evolve_fs » : déplacement sans remplacement (voir evolve_fs.c).
# Compilé par « npm run build:native » ; le résultat est native/build/Release/evolve_fs.node.
{
  "targets": [
    {
      "target_name": "evolve_fs",
      "sources": ["evolve_fs.c"],
      "defines": ["NAPI_VERSION=8"],
      "cflags": ["-Wall", "-Wextra"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          # Le fichier source est en UTF-8 (commentaires en français).
          "AdditionalOptions": ["/utf-8"]
        }
      }
    }
  ]
}
