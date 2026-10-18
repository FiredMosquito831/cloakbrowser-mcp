---
title: "Perfil de inicio de sesión persistente"
description: Reutiliza cookies, local storage, caché y estado de extensiones de CloakBrowser con un directorio de perfil persistente.
icon: material/account-key
tags:
  - User Guide
---

# Perfil de inicio de sesión persistente

Un perfil persistente conserva el estado de inicio de sesión entre sesiones del navegador.

## npm

```bash
mkdir -p .profiles/default

PLAYWRIGHT_MCP_USER_DATA_DIR="$PWD/.profiles/default" \
  npx -y cloakbrowser-mcp@latest
```

Configura el cliente MCP con el mismo comando. No compartas un directorio de perfil entre dos servidores activos.

Tras un cierre anormal, el puente elimina `.cloakbrowser-mcp-profile.lock` solo si el identificador de proceso registrado es válido y el proceso ya no existe. Los bloqueos con un propietario activo, contenido ilegible o inválido, o un estado de proceso incierto siguen impidiendo el inicio. Esta recuperación no termina los procesos de Chromium que sigan en ejecución ni elimina los bloqueos propios de Chromium.

Reinicia un solo servidor por perfil a la vez: volver a comprobar y eliminar un bloqueo obsoleto no es una operación atómica. Si falla la escritura de un archivo de bloqueo recién creado, el puente cierra su descriptor y lo elimina solo si la ruta sigue identificando ese archivo.

## Docker

```bash
docker run --rm -i \
  -e PLAYWRIGHT_MCP_USER_DATA_DIR=/data/profiles/default \
  -v "$PWD/artifacts:/data" \
  swimmwatch/cloakbrowser-mcp:latest
```

Usa rutas del contenedor en variables de entorno; la ruta del host solo aparece en el volume mount.

## Verificar

1. Pide al cliente MCP que abra una página de inicio de sesión e inicia sesión.
2. Detén el servidor correctamente.
3. Inícialo de nuevo con el mismo `PLAYWRIGHT_MCP_USER_DATA_DIR`.
4. Pide al cliente que visite el sitio otra vez y confirma que conserva la sesión.

## Relacionado

- [Configuración](../configuration.md#streamable-http-runtime-metadata)
- [Docker](../docker.md#persistent-profiles)
- [Cargar extensión de Chrome](load-chrome-extension.md)

## CloakBrowser 0.6.0

Con el modo stealth de CloakBrowser activado, un perfil persistente configurado explícitamente conserva su semilla de huella digital en `.cloakbrowser-seed`. El primer inicio tras actualizar asigna una semilla si falta el archivo. Un `--fingerprint` explícito, incluido `--fingerprint=off`, tiene prioridad y deja el archivo intacto. Con stealth desactivado, el archivo no cambia. Los archivos dañados se regeneran con una advertencia; los errores de acceso detienen el inicio.
