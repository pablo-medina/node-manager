# Node Manager

Aplicación de escritorio para instalar y administrar **versiones de Node.js** en tu máquina. Descarga desde el índice oficial, valida SHA256 y mantiene un repositorio local configurable. Pensada para usarse en **Windows**, **Linux** y **macOS**.

**Autor:** Pablo Medina  
**Licencia:** MIT (véase [`LICENSE`](./LICENSE)).

## Requisitos

- [Node.js](https://nodejs.org/) (compatible con tu versión actual del proyecto; usá `npm` para dependencias front).
- [Rust](https://www.rust-lang.org/tools/install) + toolchain para compilar `src-tauri`.
- Para empaquetar con Tauri, seguí los [prerrequisitos de Tauri 2](https://v2.tauri.app/start/prerequisites/) según tu SO.

## Cómo ejecutar en desarrollo

```powershell
npm install
npm run tauri:dev
```

Esto arranca el front con Vite y el proceso nativo de Tauri.

## Cómo compilar un instalable

```powershell
npm install
npm run tauri:build
```

Los artefactos quedan en `src-tauri/target/release/` (y subcarpetas de bundle según la plataforma).

## Scripts npm

| Script        | Descripción                                      |
|---------------|--------------------------------------------------|
| `npm run dev` | Solo front (Vite), sin shell Tauri               |
| `npm run build` | Typecheck + build estático → `dist/`         |
| `npm run preview` | Sirve `dist/` (útil para probar el bundle) |
| `npm run tauri:dev` | Modo desarrollo Tauri                     |
| `npm run tauri:build` | Build de release Tauri                   |

## Estructura del repositorio

| Ruta           | Rol |
|----------------|-----|
| `src/`         | Frontend: TypeScript + Vite, UI y comandos invocados por Tauri |
| `src/style.css`| Estilos de la aplicación |
| `src-tauri/`   | Backend Rust: comandos (`lib.rs`), configuración persistente (`app_config`), descargas y gestión del repositorio de versiones |

## Funcionalidades destacadas

- **Versiones instaladas**: listado, uso de disco, abrir carpeta en el explorador / gestor de archivos.
- **Descargas en segundo plano**: instalación asíncrona con progreso, cancelar, reintentar y limpiar trabajos terminados con error.
- **Proxy**: soporte configurable (manual y/o variables de entorno HTTP, HTTPS y NO_PROXY) desde la pantalla Configuración.
- **Temas**: claro / oscuro / según sistema.
- **Exploración e importación**: escanear instalaciones externas de Node e importar al repositorio de la app.
- **Scripts `node-set`**: generación de helpers para apuntar al Node elegido (`node-set.cmd` / `node-set.sh`).

La configuración (directorios, tema, proxy) se persiste mediante los comandos Tauri que guardan un `AppConfig` en disco.

## Contribuir y problemas

Podés reportar mejoras o fallos abriendo issues o pull requests en el repositorio del proyecto (cuando esté publicado enlazalo acá).

---

© 2026 Pablo Medina. Distribuido bajo licencia MIT.
