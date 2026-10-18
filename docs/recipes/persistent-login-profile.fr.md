---
title: "Profil de connexion persistant"
description: Réutilisez cookies, local storage, cache et état des extensions CloakBrowser avec un répertoire de profil persistant.
icon: material/account-key
tags:
  - User Guide
---

# Profil de connexion persistant

Un profil persistant conserve l’état de connexion entre les sessions navigateur.

## npm

```bash
mkdir -p .profiles/default

PLAYWRIGHT_MCP_USER_DATA_DIR="$PWD/.profiles/default" \
  npx -y cloakbrowser-mcp@latest
```

Configurez le client MCP avec la même commande. Ne partagez pas un répertoire de profil entre deux serveurs actifs.

Après un arrêt anormal, le pont supprime `.cloakbrowser-mcp-profile.lock` uniquement si l’identifiant de processus enregistré est valide et que le processus n’existe plus. Les verrous dont le propriétaire est encore actif, dont le contenu est illisible ou invalide, ou dont l’état du processus est incertain bloquent toujours le démarrage. Cette récupération n’arrête pas les processus Chromium restants et ne supprime pas les verrous propres à Chromium.

Ne redémarrez qu’un seul serveur par profil à la fois : la nouvelle vérification et la suppression d’un verrou obsolète ne sont pas atomiques. Si l’écriture d’un fichier de verrou nouvellement créé échoue, le pont ferme son descripteur et ne supprime le fichier que si le chemin désigne toujours ce fichier.

## Docker

```bash
docker run --rm -i \
  -e PLAYWRIGHT_MCP_USER_DATA_DIR=/data/profiles/default \
  -v "$PWD/artifacts:/data" \
  swimmwatch/cloakbrowser-mcp:latest
```

Utilisez des chemins de conteneur dans les variables d’environnement ; le chemin hôte apparaît seulement dans le volume mount.

## Vérifier

1. Demandez au client MCP d’ouvrir une page de connexion et connectez-vous.
2. Arrêtez le serveur correctement.
3. Redémarrez-le avec le même `PLAYWRIGHT_MCP_USER_DATA_DIR`.
4. Demandez au client de revisiter le site et vérifiez que la connexion est conservée.

## Liens associés

- [Configuration](../configuration.md#streamable-http-runtime-metadata)
- [Docker](../docker.md#persistent-profiles)
- [Charger une extension Chrome](load-chrome-extension.md)

## CloakBrowser 0.6.0

Lorsque le mode stealth de CloakBrowser est activé, un profil persistant configuré explicitement conserve sa graine d’empreinte dans `.cloakbrowser-seed`. Le premier démarrage après la mise à jour attribue une graine si le fichier est absent. Un `--fingerprint` explicite, y compris `--fingerprint=off`, est prioritaire et laisse le fichier intact. Avec stealth désactivé, le fichier ne change pas. Les fichiers corrompus sont régénérés avec un avertissement ; les erreurs d’accès empêchent le démarrage.
