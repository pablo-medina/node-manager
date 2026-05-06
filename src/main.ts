import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ProxyConfig = {
  enabled: boolean;
  use_env_http_proxy: boolean;
  use_env_https_proxy: boolean;
  use_env_no_proxy: boolean;
  http_proxy: string | null;
  https_proxy: string | null;
  no_proxy: string | null;
};

type UiConfig = {
  theme: "system" | "light" | "dark" | string;
};

type AppConfig = {
  base_dir: string;
  repository_path: string;
  proxy: ProxyConfig;
  ui: UiConfig;
};

type NodeVersionInfo = {
  version: string;
  path: string;
  size_bytes: number;
};

type DiskUsageReport = {
  total_bytes: number;
  versions: NodeVersionInfo[];
  /** Cuando falta en JSON (viejo): se muestra como no medido. */
  sizes_known?: boolean;
};

type ScanReport = {
  candidates: { version: string; path: string }[];
};

type DownloadJobPayload = {
  version: string;
  phase: string;
  message: string | null;
  receivedBytes: number;
  totalBytes: number | null;
};

const app = document.querySelector<HTMLDivElement>("#app") as HTMLDivElement;

const state: {
  config: AppConfig | null;
  versions: NodeVersionInfo[];
  downloadJobs: DownloadJobPayload[];
  scan: ScanReport | null;
  disk: DiskUsageReport | null;
  busy: boolean;
  busyMessage: string;
  /** true mientras se lee el repo / jobs al arranque (evita pantalla vacía sin contexto). */
  loadingRepo: boolean;
  section: "inicio" | "versiones" | "configuracion";
  configTab: "general" | "proxy";
  scanDialogOpen: boolean;
  aboutDialogOpen: boolean;
  versionDetailModal: null | {
    path: string;
    versionLabel: string;
    loading: boolean;
    packages: string[] | null;
    error: string | null;
  };
} = {
  config: null,
  versions: [],
  downloadJobs: [],
  scan: null,
  disk: null,
  busy: false,
  busyMessage: "",
  loadingRepo: false,
  section: "inicio",
  configTab: "general",
  scanDialogOpen: false,
  aboutDialogOpen: false,
  versionDetailModal: null,
};

let downloadEventsReady = false;

let windowResizeUnlisten: (() => void) | null = null;
let windowChromeDelegated = false;

/** Evita dos mediciones pesadas concurrentes si el usuario cambia de pestaña. */
let versionSizesLoading = false;

function formatReportedDiskTotal(disk: DiskUsageReport | null): string {
  if (!disk) {
    return "-";
  }
  if (disk.versions.length === 0) {
    return formatBytes(0);
  }
  return disk.sizes_known ? formatBytes(disk.total_bytes) : "—";
}

function installedRowDetailHtml(v: NodeVersionInfo): string {
  if (!state.disk?.sizes_known) {
    return "—";
  }
  return formatBytes(v.size_bytes);
}

function closeVersionDetailModal(): void {
  state.versionDetailModal = null;
  render();
}

function openVersionPackagesDetail(installPath: string, versionLabel: string): void {
  state.versionDetailModal = {
    path: installPath,
    versionLabel,
    loading: true,
    packages: null,
    error: null,
  };
  render();
  const guard = installPath;
  void (async () => {
    try {
      const packages = await invoke<string[]>("list_global_npm_packages", { versionPath: guard });
      if (!state.versionDetailModal || state.versionDetailModal.path !== guard) {
        return;
      }
      state.versionDetailModal = {
        path: guard,
        versionLabel,
        loading: false,
        packages,
        error: null,
      };
      render();
    } catch (err) {
      if (!state.versionDetailModal || state.versionDetailModal.path !== guard) {
        return;
      }
      state.versionDetailModal = {
        path: guard,
        versionLabel,
        loading: false,
        packages: null,
        error: formatError(err),
      };
      render();
    }
  })();
}

function versionPackagesModalMarkup(): string {
  const m = state.versionDetailModal;
  if (!m) {
    return "";
  }
  const body = m.loading
    ? `<div class="modal-loading" role="status"><span class="modal-spinner" aria-hidden="true"></span><p>Cargando…</p></div>`
    : m.error
      ? `<p class="modal-error">${escapeHtml(m.error)}</p>`
      : (m.packages?.length ?? 0) === 0
        ? `<p class="modal-muted">No hay paquetes listados para esta instalación.</p>`
        : `<div class="npm-pkg-list">${m.packages!.map((p) => `<div class="npm-pkg-row"><code>${escapeHtml(p)}</code></div>`).join("")}</div>`;

  return `
    <div class="modal-backdrop win-modal-backdrop" id="versionDetailBackdrop" role="presentation">
      <div class="modal-dialog win-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="npmDetailTitle" tabindex="-1">
        <div class="modal-head win-modal-titlebar">
          <h3 id="npmDetailTitle">Paquetes — ${escapeHtml(m.versionLabel)}</h3>
          <button type="button" class="icon-btn modal-close" aria-label="Cerrar" id="versionDetailClose">${ICON_CLOSE}</button>
        </div>
        <div class="modal-body win-modal-body">
          ${body}
        </div>
      </div>
    </div>`;
}

function closeScanDialog(): void {
  state.scanDialogOpen = false;
  render();
}

function openScanDialog(): void {
  state.scanDialogOpen = true;
  render();
}

function closeAboutDialog(): void {
  state.aboutDialogOpen = false;
  render();
}

function openAboutDialog(): void {
  state.aboutDialogOpen = true;
  render();
}

function scanDialogMarkup(): string {
  if (!state.scanDialogOpen) {
    return "";
  }
  const candidates = state.scan?.candidates ?? [];
  const tableInner =
    candidates.length === 0
      ? `<p class="modal-muted dialog-empty-hint">Tocá «Escanear disco» para buscar instalaciones Node en rutas habituales.</p>`
      : `
      <div class="table table-explore-dialog">
        <div class="row head explore-head"><span>Versión</span><span>Ruta detectada</span><span class="col-actions-import">Acción</span></div>
        ${candidates
          .map(
            (c) => `
        <div class="row explore-row">
          <span class="mono">${escapeHtml(c.version)}</span>
          <span class="cell-path-muted">${escapeHtml(c.path)}</span>
          <span class="cell-actions-import"><button type="button" class="sm importBtn" data-path="${encodeURIComponent(c.path)}" data-version="${encodeURIComponent(c.version)}" ${
            state.busy ? "disabled" : ""
          }>Importar</button></span>
        </div>`,
          )
          .join("")}
      </div>`;

  return `
    <div class="modal-backdrop win-modal-backdrop" id="scanDialogBackdrop" role="presentation">
      <div class="modal-dialog win-modal-dialog modal-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="scanDialogTitle" tabindex="-1">
        <div class="modal-head win-modal-titlebar">
          <h3 id="scanDialogTitle">Explorar disco</h3>
          <button type="button" class="icon-btn modal-close" aria-label="Cerrar" id="scanDialogClose">${ICON_CLOSE}</button>
        </div>
        <div class="modal-body win-modal-body">
          <p class="modal-sub">Importá copias de Node encontradas en el sistema al repositorio local gestionado por la app.</p>
          <div class="dialog-toolbar">
            <button type="button" id="scanBtn" ${state.busy ? "disabled" : ""}>Escanear disco</button>
          </div>
          ${tableInner}
        </div>
      </div>
    </div>`;
}

function aboutDialogMarkup(): string {
  if (!state.aboutDialogOpen) {
    return "";
  }
  return `
    <div class="modal-backdrop win-modal-backdrop" id="aboutDialogBackdrop" role="presentation">
      <div class="modal-dialog win-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="aboutTitle" tabindex="-1">
        <div class="modal-head win-modal-titlebar">
          <h3 id="aboutTitle">Acerca de Node Manager</h3>
          <button type="button" class="icon-btn modal-close" aria-label="Cerrar" id="aboutDialogClose">${ICON_CLOSE}</button>
        </div>
        <div class="modal-body win-modal-body about-dialog-body">
          <p class="about-lead"><strong>Node Manager</strong> — instalaciones y versiones de Node.js desde el escritorio.</p>
          <p class="modal-muted">Versión <strong>0.1.0</strong> · Tauri 2 · Vite · Rust</p>
          <p class="modal-muted">Autor: <strong>Pablo Medina</strong><br />Licencia MIT</p>
        </div>
      </div>
    </div>`;
}

type DialogDragState = {
  dialog: HTMLElement;
  grabX: number;
  grabY: number;
};

/** Arrastrar modales por la barra de título (dentro del área de la ventana). */
function wireDraggableModals(): void {
  const ids = ["versionDetailBackdrop", "scanDialogBackdrop", "aboutDialogBackdrop"];
  for (const id of ids) {
    const root = document.getElementById(id);
    if (!root) {
      continue;
    }
    const dialog = root.querySelector<HTMLElement>(".win-modal-dialog");
    const titlebar = root.querySelector<HTMLElement>(".win-modal-titlebar");
    if (!dialog || !titlebar) {
      continue;
    }

    let drag: DialogDragState | null = null;

    titlebar.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      if ((e.target as HTMLElement).closest("button")) {
        return;
      }
      const r = dialog.getBoundingClientRect();
      dialog.style.position = "fixed";
      dialog.style.left = `${r.left}px`;
      dialog.style.top = `${r.top}px`;
      dialog.style.transform = "none";
      dialog.style.margin = "0";
      dialog.style.right = "auto";
      dialog.style.bottom = "auto";
      drag = { dialog, grabX: e.clientX - r.left, grabY: e.clientY - r.top };
      titlebar.setPointerCapture(e.pointerId);
      titlebar.classList.add("is-dragging");
      e.preventDefault();
    });

    titlebar.addEventListener("pointermove", (e: PointerEvent) => {
      if (!drag || drag.dialog !== dialog) {
        return;
      }
      const pad = 8;
      let x = e.clientX - drag.grabX;
      let y = e.clientY - drag.grabY;
      const maxX = window.innerWidth - dialog.offsetWidth - pad;
      const maxY = window.innerHeight - dialog.offsetHeight - pad;
      x = Math.min(Math.max(pad, x), Math.max(pad, maxX));
      y = Math.min(Math.max(pad, y), Math.max(pad, maxY));
      dialog.style.left = `${x}px`;
      dialog.style.top = `${y}px`;
    });

    const finish = (e: PointerEvent) => {
      if (!titlebar.hasPointerCapture(e.pointerId)) {
        return;
      }
      titlebar.releasePointerCapture(e.pointerId);
      titlebar.classList.remove("is-dragging");
      drag = null;
    };

    titlebar.addEventListener("pointerup", finish);
    titlebar.addEventListener("pointercancel", finish);
  }
}

const SVG_OPTS = `xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

const ICON_FOLDER = `<svg ${SVG_OPTS} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
const ICON_STOP = `<svg ${SVG_OPTS} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>`;
const ICON_RETRY = `<svg ${SVG_OPTS} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>`;
const ICON_CLOSE = `<svg ${SVG_OPTS} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const ICON_DELETE = `<svg ${SVG_OPTS} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const ICON_PACKAGES = `<svg ${SVG_OPTS} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><path d="M9 2v4h6V2"/><path d="M8 12h8M8 16h5"/></svg>`;
/** Ícono marca: nodo/terminal para representar gestión de Node.js. */
const ICON_LEAF = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 20 6.6v10.8L12 22 4 17.4V6.6L12 2Z"/><path d="M9.25 10.4v4.2"/><path d="M12 9.4v5.2"/><path d="M14.75 11.2v3.4"/></svg>`;

/** Íconos de ventana: el glifo Unicode □ se ve muy chico respecto del − y la ✕ en Segoe UI. */
const WC_MAXIMIZE = `<svg ${SVG_OPTS} class="wc-icon-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="0.75" fill="none"/></svg>`;
const WC_RESTORE = `<svg ${SVG_OPTS} class="wc-icon-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="4.5" y="10.5" width="10" height="10" rx="0.65" fill="none"/><rect x="9.5" y="5.5" width="10" height="10" rx="0.65" fill="none"/></svg>`;

const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(2)} ${units[idx]}`;
};

const setTheme = (theme: string) => {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
};

const notify = (msg: string, isError = false) => {
  const box = document.querySelector<HTMLDivElement>("#notice");
  if (!box) {
    return;
  }
  box.textContent = msg;
  box.classList.toggle("error", isError);
};

const formatError = (err: unknown) => {
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Ocurrió un error inesperado.";
};

const readOptionalInput = (selector: string): string | null => {
  const value = (document.querySelector<HTMLInputElement>(selector)?.value || "").trim();
  return value || null;
};

const withBusy = async (message: string, fn: () => Promise<void>) => {
  if (state.busy) {
    return;
  }
  state.busy = true;
  state.busyMessage = message;
  render();
  try {
    await fn();
  } catch (err) {
    notify(formatError(err), true);
  } finally {
    state.busy = false;
    state.busyMessage = "";
    render();
  }
};

async function loadConfig() {
  const cfg = await invoke<AppConfig>("get_settings");
  state.config = cfg;
  setTheme(cfg.ui.theme);
}

async function refreshVersionsAndReports(options?: { detailed?: boolean }) {
  const cmd = options?.detailed ? "disk_usage_report_detailed" : "disk_usage_report";
  const disk = await invoke<DiskUsageReport>(cmd);
  state.disk = disk;
  state.versions = disk.versions;
}

async function ensureVersionSizesLoaded(): Promise<void> {
  if (state.section !== "versiones") {
    return;
  }
  const sizesKnown = state.disk?.sizes_known === true;
  if (!state.disk || sizesKnown || state.versions.length === 0 || versionSizesLoading) {
    return;
  }
  versionSizesLoading = true;
  try {
    await refreshVersionsAndReports({ detailed: true });
  } catch (err) {
    notify(formatError(err), true);
  } finally {
    versionSizesLoading = false;
    render();
  }
}

async function refreshDownloadJobs() {
  state.downloadJobs = await invoke<DownloadJobPayload[]>("list_download_jobs");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jobPhaseLabel(phase: string): string {
  const m: Record<string, string> = {
    queued: "En cola",
    resolving: "Comprobando",
    downloading: "Descargando",
    verifying: "Verificando",
    extracting: "Extrayendo",
    cancelling: "Cancelando",
    cancelled: "Cancelada",
    failed: "Error",
    complete: "Listo",
  };
  return m[phase] ?? phase;
}

function jobDetailLine(job: DownloadJobPayload): string {
  if (job.phase === "downloading") {
    if (job.totalBytes && job.totalBytes > 0) {
      const pct = Math.min(
        100,
        Math.round((job.receivedBytes / job.totalBytes) * 100),
      );
      return `${pct}% · ${formatBytes(job.receivedBytes)} / ${formatBytes(job.totalBytes)}`;
    }
    return `${formatBytes(job.receivedBytes)} descargados`;
  }
  if (job.phase === "failed" || job.phase === "cancelled") {
    return job.message ? escapeHtml(job.message) : "—";
  }
  return job.message ? escapeHtml(job.message) : "—";
}

function jobProgressPct(job: DownloadJobPayload): number | null {
  if (job.phase !== "downloading" || !job.totalBytes || job.totalBytes <= 0) {
    return null;
  }
  return Math.min(100, Math.round((job.receivedBytes / job.totalBytes) * 100));
}

function jobRowActions(job: DownloadJobPayload): string {
  const v = job.version;
  const busy = ["queued", "resolving", "downloading", "verifying", "extracting", "cancelling"].includes(
    job.phase,
  );
  if (busy) {
    return `<button type="button" class="icon-btn" title="Cancelar descarga" aria-label="Cancelar descarga" data-v="${v}" data-job="cancel">${ICON_STOP}</button>`;
  }
  if (job.phase === "failed") {
    return `<span class="icon-actions"><button type="button" class="icon-btn" title="Reintentar descarga" aria-label="Reintentar" data-v="${v}" data-job="retry">${ICON_RETRY}</button><button type="button" class="icon-btn icon-muted" title="Quitar de la lista" aria-label="Quitar" data-v="${v}" data-job="dismiss">${ICON_CLOSE}</button></span>`;
  }
  if (job.phase === "cancelled") {
    return `<button type="button" class="icon-btn icon-muted" title="Quitar de la lista" aria-label="Quitar" data-v="${v}" data-job="dismiss">${ICON_CLOSE}</button>`;
  }
  return `<span class="muted-dash">—</span>`;
}

async function attachDownloadListenersOnce() {
  if (downloadEventsReady) {
    return;
  }
  downloadEventsReady = true;
  await listen("download-update", async () => {
    await refreshDownloadJobs();
    render();
  });
  await listen<string>("download-complete", async (event) => {
    await refreshVersionsAndReports({ detailed: true });
    await refreshDownloadJobs();
    const ver = event.payload;
    notify(ver ? `Versión ${ver} instalada correctamente.` : "Instalación completada.");
    render();
  });
}

function onGlobalEscapeKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") {
    return;
  }
  if (state.versionDetailModal) {
    e.preventDefault();
    closeVersionDetailModal();
    return;
  }
  if (state.scanDialogOpen) {
    e.preventDefault();
    closeScanDialog();
    return;
  }
  if (state.aboutDialogOpen) {
    e.preventDefault();
    closeAboutDialog();
    return;
  }
}

async function syncWindowMaximizeButton(): Promise<void> {
  const maxBtn = document.querySelector<HTMLButtonElement>("#wcToggleMaximize");
  if (!maxBtn) {
    return;
  }
  try {
    const maximized = await getCurrentWindow().isMaximized();
    maxBtn.classList.toggle("is-maximized", maximized);
    maxBtn.setAttribute("aria-label", maximized ? "Restaurar" : "Maximizar");
    maxBtn.title = maximized ? "Restaurar" : "Maximizar";
  } catch {
    /* Fuera de Tauri (p. ej. vite en navegador). */
  }
}

async function wireWindowChromeOnce(): Promise<void> {
  try {
    const win = getCurrentWindow();
    if (!windowChromeDelegated) {
      windowChromeDelegated = true;
      app.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("button");
        const id = btn?.id;
        if (id === "wcMinimize") {
          void win.minimize();
        } else if (id === "wcToggleMaximize") {
          void win.toggleMaximize();
        } else if (id === "wcClose") {
          void win.close();
        }
      });
    }
    if (!windowResizeUnlisten) {
      windowResizeUnlisten = await win.onResized(() => {
        void syncWindowMaximizeButton();
      });
    }
  } catch {
    /* Sin API de ventana (vite en navegador). */
  }
  await syncWindowMaximizeButton();
}

async function init() {
  window.addEventListener("keydown", onGlobalEscapeKey);
  state.loadingRepo = true;
  try {
    await loadConfig();
    render();
    await Promise.all([refreshVersionsAndReports(), refreshDownloadJobs(), attachDownloadListenersOnce()]);
  } catch (err) {
    notify(`Error de inicialización: ${formatError(err)}`, true);
  } finally {
    state.loadingRepo = false;
  }
  render();
  if (state.section === "versiones") {
    void ensureVersionSizesLoaded();
  }
  void wireWindowChromeOnce();
}

function render() {
  const cfg = state.config;
  const stats = {
    installed: state.versions.length,
    totalDisk: formatReportedDiskTotal(state.disk),
    scanned: state.scan?.candidates.length ?? 0,
  };
  app.innerHTML = `
    <div class="app-frame">
      <div class="zen-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <span class="sidebar-leaf" aria-hidden="true">${ICON_LEAF}</span>
          <h1 class="sidebar-title">Node Manager</h1>
        </div>
        <nav class="menu">
          <button class="menu-btn ${state.section === "inicio" ? "active" : ""}" data-section="inicio">Inicio</button>
          <button class="menu-btn ${state.section === "versiones" ? "active" : ""}" data-section="versiones">Versiones</button>
          <button class="menu-btn ${state.section === "configuracion" ? "active" : ""}" data-section="configuracion">Configuración</button>
        </nav>
        <p id="notice" class="notice"></p>
        <div class="sidebar-spacer" aria-hidden="true"></div>
        <button type="button" class="sidebar-about-btn" id="openAboutBtn">Acerca de…</button>
      </aside>
      <header class="zen-main-chrome" role="banner">
        <div class="zen-main-drag" data-tauri-drag-region aria-label="Arrastrar para mover la ventana"></div>
        <div class="window-controls" aria-label="Controles de ventana">
          <button type="button" class="wc-btn wc-minimize" id="wcMinimize" title="Minimizar">─</button>
          <button type="button" class="wc-btn wc-maximize" id="wcToggleMaximize" title="Maximizar">
            <span class="wc-glyph wc-max" aria-hidden="true">${WC_MAXIMIZE}</span>
            <span class="wc-glyph wc-restore" aria-hidden="true">${WC_RESTORE}</span>
          </button>
          <button type="button" class="wc-btn wc-close" id="wcClose" title="Cerrar">✕</button>
        </div>
      </header>
      <div class="app-body zen-main-body">
      <main class="app-main-column">
      <section class="workspace">
        ${state.loadingRepo ? `<div class="loading-banner" role="status">Cargando versiones y trabajos en segundo plano…</div>` : ""}
        ${state.busyMessage ? `<div class="busy-banner">Procesando: ${state.busyMessage}</div>` : ""}
        ${
          state.section === "inicio"
            ? `
          <header class="page-head">
            <h2>Panel principal</h2>
            <p class="hint">Vista general del estado actual.</p>
          </header>
          <section class="group-panel">
            <div class="kpi-grid">
              <article class="kpi"><strong>${stats.installed}</strong><span>Versiones instaladas</span></article>
              <article class="kpi"><strong>${stats.totalDisk}</strong><span>Espacio total</span></article>
              <article class="kpi"><strong>${stats.scanned}</strong><span>Versiones detectadas</span></article>
            </div>
          </section>

          <section class="group-panel">
            <h3>Acciones rápidas</h3>
            <div class="setting-row">
              <div class="setting-meta">
                <strong>Instalar versión</strong>
                <p>Descarga desde el repositorio oficial de Node.js y verifica checksum.</p>
              </div>
              <div class="setting-action inline">
                <input id="versionInput" placeholder="24.14.0" ${state.busy ? "disabled" : ""}/>
                <button type="button" class="btn-zen-secondary" id="installBtn" ${state.busy ? "disabled" : ""}>Descargar e instalar</button>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-meta">
                <strong>Script de activación</strong>
                <p>Regenera node-set para cambiar versión por terminal.</p>
              </div>
              <div class="setting-action">
                <button type="button" class="btn-zen-accent" id="scriptBtn" ${state.busy ? "disabled" : ""}>Generar script node-set</button>
              </div>
            </div>
          </section>
        `
            : ""
        }

        ${
          state.section === "versiones"
            ? `
          <header class="page-head page-head-toolbar">
            <div class="page-head-main">
              <h2>Versiones y descargas</h2>
              <p class="hint">Total en disco: ${formatReportedDiskTotal(state.disk)}. Los tamaños se calculan al entrar acá; el ícono de lista muestra los paquetes de la instalación.</p>
            </div>
            <div class="page-head-actions">
              <button type="button" class="btn-zen-outline toolbar-btn" id="openScanDialogBtn">Explorar disco</button>
            </div>
          </header>
          <div class="table table-versions">
              <div class="row head"><span>Versión</span><span>Estado</span><span>Detalle</span><span class="col-actions-head">Acciones</span></div>
              ${(() => {
                const jobVers = new Set(state.downloadJobs.map((j) => j.version));
                const jobRows = state.downloadJobs
                  .map((j) => {
                    const pct = jobProgressPct(j);
                    const bar =
                      pct === null
                        ? ""
                        : `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;
                    return `
                  <div class="row row-job" data-phase="${escapeHtml(j.phase)}">
                    <span class="mono">${escapeHtml(j.version)}</span>
                    <span>${jobPhaseLabel(j.phase)}</span>
                    <span class="cell-detail">${jobDetailLine(j)}${bar}</span>
                    <span class="cell-actions">${jobRowActions(j)}</span>
                  </div>`;
                  })
                  .join("");
                const installedRows = state.versions
                  .filter((v) => !jobVers.has(v.version))
                  .map(
                    (v) => `
                  <div class="row row-installed">
                    <span class="mono">${escapeHtml(v.version)}</span>
                    <span>Instalada</span>
                    <span class="cell-detail">${installedRowDetailHtml(v)}</span>
                    <span class="cell-actions icon-actions">
                      <button type="button" class="icon-btn" title="Ver paquetes de esta versión" aria-label="Ver paquetes" data-installed="packages" data-path="${encodeURIComponent(v.path)}" data-v="${encodeURIComponent(v.version)}">${ICON_PACKAGES}</button>
                      <button type="button" class="icon-btn" title="Abrir carpeta en el explorador" aria-label="Abrir carpeta" data-installed="folder" data-path="${encodeURIComponent(v.path)}">${ICON_FOLDER}</button>
                      <button type="button" class="icon-btn icon-delete" title="Eliminar esta versión" aria-label="Eliminar versión" data-installed="delete" data-v="${v.version}">${ICON_DELETE}</button>
                    </span>
                  </div>`,
                  )
                  .join("");
                const body = jobRows + installedRows;
                return body.trim()
                  ? body
                  : `<div class="versions-table-empty"><p class="empty-msg">No hay versiones instaladas ni trabajos de descarga.</p></div>`;
              })()}
          </div>
        `
            : ""
        }

        ${
          state.section === "configuracion"
            ? `
          <header class="page-head">
            <h2>Configuración</h2>
            <p class="hint">Parámetros persistentes de la aplicación.</p>
          </header>
          <section class="group-panel config-shell">
            <div class="config-tabs" role="tablist">
              <button type="button" role="tab" aria-selected="${
                state.configTab === "general"
              }" class="cfg-tab ${state.configTab === "general" ? "cfg-tab-active" : ""}" data-cfg-tab="general">General</button>
              <button type="button" role="tab" aria-selected="${
                state.configTab === "proxy"
              }" class="cfg-tab ${state.configTab === "proxy" ? "cfg-tab-active" : ""}" data-cfg-tab="proxy">Proxy</button>
            </div>

            <div class="cfg-panels">
              <div class="cfg-panel" id="cfg-panel-general" role="tabpanel" ${
                state.configTab !== "general" ? 'hidden=""' : ""
              }>
                <div class="setting-row stack">
                  <div class="setting-meta">
                    <strong>Directorio base</strong>
                    <p>Ubicación raíz donde se generan scripts y datos de trabajo.</p>
                  </div>
                  <div class="setting-action-full">
                    <input id="baseDir" value="${cfg?.base_dir ?? ""}" ${state.busy ? "disabled" : ""} />
                  </div>
                </div>
                <div class="setting-row stack">
                  <div class="setting-meta">
                    <strong>Repositorio local</strong>
                    <p>Ruta donde se guardan las versiones instaladas por la app.</p>
                  </div>
                  <div class="setting-action-full">
                    <input id="repoDir" value="${cfg?.repository_path ?? ""}" ${state.busy ? "disabled" : ""} />
                  </div>
                </div>
                <div class="setting-row stack">
                  <div class="setting-meta">
                    <strong>Tema</strong>
                    <p>Seleccioná el modo visual de la aplicación.</p>
                  </div>
                  <div class="setting-action-full">
                    <select id="themeSelect" ${state.busy ? "disabled" : ""}>
                      <option value="system" ${cfg?.ui.theme === "system" ? "selected" : ""}>Sistema</option>
                      <option value="light" ${cfg?.ui.theme === "light" ? "selected" : ""}>Claro</option>
                      <option value="dark" ${cfg?.ui.theme === "dark" ? "selected" : ""}>Oscuro</option>
                    </select>
                  </div>
                </div>
              </div>

              <div class="cfg-panel" id="cfg-panel-proxy" role="tabpanel" ${
                state.configTab !== "proxy" ? 'hidden=""' : ""
              }>
                <div class="proxy-master-row">
                  <div class="proxy-master-copy">
                    <strong>Habilitar proxy</strong>
                    <p>Definí proxy manual o por variables de entorno.</p>
                  </div>
                  <label class="switch-inline proxy-master-toggle"><input id="proxyEnabled" type="checkbox" ${
                    cfg?.proxy.enabled ? "checked" : ""
                  } ${state.busy ? "disabled" : ""}/> Activado</label>
                </div>

                <div class="proxy-option-block">
                  <div class="proxy-check-row">
                    <input id="useEnvHttp" type="checkbox" ${cfg?.proxy.use_env_http_proxy ? "checked" : ""} ${
                      state.busy ? "disabled" : ""
                    }/>
                    <label for="useEnvHttp" class="proxy-label">Usar <code>HTTP_PROXY</code>/<code>http_proxy</code>.</label>
                  </div>
                  <label class="proxy-input-label" for="httpProxy">URL manual HTTP (si no usás sólo entorno)</label>
                  <input id="httpProxy" value="${cfg?.proxy.http_proxy ?? ""}" placeholder="http://usuario:pass@host:puerto" ${
                    state.busy || cfg?.proxy.use_env_http_proxy ? "disabled" : ""
                  }/>
                </div>

                <div class="proxy-option-block">
                  <div class="proxy-check-row">
                    <input id="useEnvHttps" type="checkbox" ${cfg?.proxy.use_env_https_proxy ? "checked" : ""} ${
                      state.busy ? "disabled" : ""
                    }/>
                    <label for="useEnvHttps" class="proxy-label">Usar <code>HTTPS_PROXY</code>/<code>https_proxy</code>.</label>
                  </div>
                  <label class="proxy-input-label" for="httpsProxy">URL manual HTTPS</label>
                  <input id="httpsProxy" value="${cfg?.proxy.https_proxy ?? ""}" placeholder="http://usuario:pass@host:puerto" ${
                    state.busy || cfg?.proxy.use_env_https_proxy ? "disabled" : ""
                  }/>
                </div>

                <div class="proxy-option-block">
                  <div class="proxy-check-row">
                    <input id="useEnvNoProxy" type="checkbox" ${cfg?.proxy.use_env_no_proxy ? "checked" : ""} ${
                      state.busy ? "disabled" : ""
                    }/>
                    <label for="useEnvNoProxy" class="proxy-label">Usar <code>NO_PROXY</code>/<code>no_proxy</code>.</label>
                  </div>
                  <label class="proxy-input-label" for="noProxy">Lista manual NO_PROXY</label>
                  <input id="noProxy" value="${cfg?.proxy.no_proxy ?? ""}" placeholder="localhost,127.0.0.1,.dominio.local" ${
                    state.busy || cfg?.proxy.use_env_no_proxy ? "disabled" : ""
                  }/>
                </div>
              </div>
            </div>

            <div class="actions-end config-save-bar">
              <button id="saveAllSettings" type="button" ${state.busy ? "disabled" : ""}>Guardar configuración</button>
            </div>
          </section>
        `
            : ""
        }
      </section>
      ${versionPackagesModalMarkup()}${scanDialogMarkup()}${aboutDialogMarkup()}
    </main>
    </div>
      </div>
    </div>
  `;

  document.querySelectorAll<HTMLButtonElement>(".menu-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.dataset.section as typeof state.section;
      if (!section) {
        return;
      }
      state.section = section;
      render();
      if (section === "versiones") {
        void ensureVersionSizesLoaded();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-cfg-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.cfgTab as typeof state.configTab | undefined;
      if (tab !== "general" && tab !== "proxy") {
        return;
      }
      state.configTab = tab;
      render();
    });
  });

  const syncProxyInputDisabled = () => {
    const busy = state.busy;
    const http = document.querySelector<HTMLInputElement>("#httpProxy");
    const https = document.querySelector<HTMLInputElement>("#httpsProxy");
    const noPx = document.querySelector<HTMLInputElement>("#noProxy");
    if (http) {
      http.disabled = busy || !!(document.querySelector<HTMLInputElement>("#useEnvHttp")?.checked);
    }
    if (https) {
      https.disabled = busy || !!(document.querySelector<HTMLInputElement>("#useEnvHttps")?.checked);
    }
    if (noPx) {
      noPx.disabled = busy || !!(document.querySelector<HTMLInputElement>("#useEnvNoProxy")?.checked);
    }
  };
  ["useEnvHttp", "useEnvHttps", "useEnvNoProxy"].forEach((chkId) => {
    document.querySelector<HTMLInputElement>(`#${chkId}`)?.addEventListener("change", syncProxyInputDisabled);
  });
  syncProxyInputDisabled();

  document.querySelector<HTMLButtonElement>("#saveAllSettings")?.addEventListener("click", () => {
    if (!state.config) {
      return;
    }
    // Leemos los inputs antes del render de "busy" para no perder edición en curso.
    const draft = {
      base_dir: (document.querySelector<HTMLInputElement>("#baseDir")?.value || "").trim(),
      repository_path: (document.querySelector<HTMLInputElement>("#repoDir")?.value || "").trim(),
      theme: (document.querySelector<HTMLSelectElement>("#themeSelect")?.value || "system").trim(),
      enabled: document.querySelector<HTMLInputElement>("#proxyEnabled")?.checked ?? false,
      use_env_http_proxy: document.querySelector<HTMLInputElement>("#useEnvHttp")?.checked ?? false,
      use_env_https_proxy: document.querySelector<HTMLInputElement>("#useEnvHttps")?.checked ?? false,
      use_env_no_proxy: document.querySelector<HTMLInputElement>("#useEnvNoProxy")?.checked ?? false,
      http_proxy: readOptionalInput("#httpProxy"),
      https_proxy: readOptionalInput("#httpsProxy"),
      no_proxy: readOptionalInput("#noProxy"),
    };

    void withBusy("guardando configuración", async () => {
      const proxy: ProxyConfig = {
        enabled: draft.enabled,
        use_env_http_proxy: draft.use_env_http_proxy,
        use_env_https_proxy: draft.use_env_https_proxy,
        use_env_no_proxy: draft.use_env_no_proxy,
        http_proxy: draft.http_proxy,
        https_proxy: draft.https_proxy,
        no_proxy: draft.no_proxy,
      };
      const nextCfg: AppConfig = {
        ...state.config!,
        base_dir: draft.base_dir,
        repository_path: draft.repository_path,
        ui: { theme: draft.theme },
        proxy,
      };
      state.config = await invoke<AppConfig>("save_settings", { config: nextCfg });
      setTheme(draft.theme);
      await refreshVersionsAndReports();
      notify("Configuración guardada.");
      render();
    });
  });

  const installBtn = document.querySelector<HTMLButtonElement>("#installBtn");
  const versionInput = document.querySelector<HTMLInputElement>("#versionInput");
  versionInput?.addEventListener("input", () => {
    if (installBtn) {
      installBtn.disabled = state.busy || !versionInput.value.trim();
    }
  });
  if (installBtn && versionInput) {
    installBtn.disabled = state.busy || !versionInput.value.trim();
  }

  installBtn?.addEventListener("click", async () => {
    const version = (versionInput?.value || "").trim();
    if (!version) {
      notify("Indicá una versión válida.", true);
      return;
    }
    try {
      await invoke("start_background_install", { version });
      state.section = "versiones";
      notify(`Descarga de Node ${version} iniciada.`);
      await refreshDownloadJobs();
      if (versionInput) {
        versionInput.value = "";
      }
      if (installBtn) {
        installBtn.disabled = true;
      }
      render();
      void ensureVersionSizesLoaded();
    } catch (err) {
      notify(formatError(err), true);
    }
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-job]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const v = btn.dataset.v ?? "";
      const role = btn.dataset.job;
      if (!v || !role) {
        return;
      }
      try {
        if (role === "cancel") {
          await invoke("cancel_background_install", { version: v });
          notify("Se solicitó cancelar la descarga.");
        } else if (role === "retry") {
          await invoke("retry_background_install", { version: v });
          notify(`Reintento iniciado para Node ${v}.`);
        } else if (role === "dismiss") {
          await invoke("dismiss_download_job", { version: v });
        }
        await refreshDownloadJobs();
        render();
      } catch (err) {
        notify(formatError(err), true);
      }
    });
  });

  document.querySelector("#versionDetailBackdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeVersionDetailModal();
    }
  });
  document.querySelector("#versionDetailClose")?.addEventListener("click", () => {
    closeVersionDetailModal();
  });

  document.querySelector("#openScanDialogBtn")?.addEventListener("click", () => {
    openScanDialog();
  });
  document.querySelector("#openAboutBtn")?.addEventListener("click", () => {
    openAboutDialog();
  });

  document.querySelector("#scanDialogBackdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeScanDialog();
    }
  });
  document.querySelector("#scanDialogClose")?.addEventListener("click", () => {
    closeScanDialog();
  });

  document.querySelector("#aboutDialogBackdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeAboutDialog();
    }
  });
  document.querySelector("#aboutDialogClose")?.addEventListener("click", () => {
    closeAboutDialog();
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-installed]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const role = btn.dataset.installed ?? "";
      if (role === "folder") {
        const encoded = btn.dataset.path ?? "";
        try {
          const path = decodeURIComponent(encoded);
          await invoke("open_version_folder", { path });
        } catch (err) {
          notify(formatError(err), true);
        }
        return;
      }
      if (role === "packages") {
        const encoded = btn.dataset.path ?? "";
        const vEnc = btn.dataset.v ?? "";
        let installPath: string;
        let versionLabel: string;
        try {
          installPath = decodeURIComponent(encoded);
          versionLabel = decodeURIComponent(vEnc);
        } catch {
          notify("No se pudo leer la instalación.", true);
          return;
        }
        openVersionPackagesDetail(installPath, versionLabel);
        return;
      }
      if (role === "delete") {
        const v = btn.dataset.v ?? "";
        if (
          !v ||
          !window.confirm(
            `¿Eliminar Node ${v} del repositorio local gestionado? Esta operación es permanente.`,
          )
        ) {
          return;
        }
        try {
          await invoke("delete_installed_version", { version: v });
          await refreshVersionsAndReports({ detailed: true });
          await refreshDownloadJobs();
          notify(`Versión ${v} eliminada del repositorio.`);
          render();
        } catch (err) {
          notify(formatError(err), true);
        }
      }
    });
  });

  const scriptBtn = document.querySelector<HTMLButtonElement>("#scriptBtn");
  scriptBtn?.addEventListener("click", () =>
    withBusy("generando script", async () => {
      const path = await invoke<string>("generate_node_set_script");
      notify(`Script generado: ${path}`);
      render();
    }),
  );

  const scanBtn = document.querySelector<HTMLButtonElement>("#scanBtn");
  scanBtn?.addEventListener("click", () =>
    withBusy("escaneando disco", async () => {
      notify("Escaneando disco en busca de instalaciones Node...");
      state.scan = await invoke<ScanReport>("scan_external_nodes");
      notify(`Escaneo finalizado. Hallazgos: ${state.scan.candidates.length}.`);
      render();
    }),
  );

  document.querySelectorAll<HTMLButtonElement>(".importBtn").forEach((btn) => {
    btn.addEventListener("click", () =>
      withBusy("importando instalación externa", async () => {
        let path: string;
        let version: string;
        try {
          path = decodeURIComponent(btn.dataset.path ?? "");
          version = decodeURIComponent(btn.dataset.version ?? "");
        } catch {
          notify("No se pudo leer los datos de importación.", true);
          return;
        }
        if (!path || !version) {
          notify("No se pudo leer los datos de importación.", true);
          return;
        }
        await invoke<NodeVersionInfo>("import_external_node", { path, version });
        await refreshVersionsAndReports({ detailed: true });
        state.scan = await invoke<ScanReport>("scan_external_nodes");
        notify(`Versión ${version} importada correctamente.`);
        render();
      }),
    );
  });

  wireDraggableModals();
}

void init();
