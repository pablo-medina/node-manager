use crate::app_config::ProxyConfig;
use reqwest::NoProxy;
use tauri::Emitter;
use crate::node_manager::{
  flatten_extracted_folder,
  normalize_version,
};
use futures_util::StreamExt;
use reqwest::Proxy as ReqwestProxy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const NODE_DIST_BASE: &str = "https://nodejs.org/dist";

fn cleanup_failed_download(repo: &Path, normalized: &str) {
  let (to, ta, ext) = crate::node_manager::detect_target();
  let artifact = format!("node-v{normalized}-{to}-{ta}.{ext}");
  let _ = std::fs::remove_file(repo.join(format!("{artifact}.partial")));
  let _ = std::fs::remove_file(repo.join(&artifact));
  let od = crate::node_manager::version_dir(repo, normalized);
  if od.exists() && !crate::node_manager::node_exec(&od).exists() {
    let _ = std::fs::remove_dir_all(&od);
  }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobPayload {
  pub version: String,
  pub phase: String,
  pub message: Option<String>,
  pub received_bytes: u64,
  pub total_bytes: Option<u64>,
}

struct JobEntry {
  payload: DownloadJobPayload,
  cancel: CancellationToken,
}

#[derive(Clone)]
pub struct DownloadService {
  jobs: Arc<Mutex<HashMap<String, JobEntry>>>,
}

impl DownloadService {
  pub fn new() -> Self {
    Self {
      jobs: Arc::new(Mutex::new(HashMap::new())),
    }
  }

  async fn notify(
    &self,
    app: &tauri::AppHandle,
    version: &str,
    phase: &str,
    message: Option<String>,
    received: u64,
    total: Option<u64>,
  ) {
    {
      let mut g = self.jobs.lock().await;
      if let Some(e) = g.get_mut(version) {
        e.payload.phase = phase.to_string();
        e.payload.message = message.clone();
        e.payload.received_bytes = received;
        e.payload.total_bytes = total;
      }
    }
    let _ = app.emit(
      "download-update",
      DownloadJobPayload {
        version: version.to_string(),
        phase: phase.to_string(),
        message,
        received_bytes: received,
        total_bytes: total,
      },
    );
  }

  pub async fn list_jobs(&self) -> Vec<DownloadJobPayload> {
    let g = self.jobs.lock().await;
    g.values().map(|j| j.payload.clone()).collect()
  }

  pub async fn cancel(&self, version: &str) -> Result<(), String> {
    let v = normalize_version(version);
    let mut g = self.jobs.lock().await;
    let entry = g.get_mut(&v).ok_or_else(|| "No hay una descarga registrada.".to_string())?;
    match entry.payload.phase.as_str() {
      "failed" | "cancelled" | "complete" => return Err("La tarea ya finalizó.".to_string()),
      _ => {}
    }
    entry.cancel.cancel();
    entry.payload.phase = "cancelling".to_string();
    entry.payload.message = Some("Cancelando…".into());
    Ok(())
  }

  pub async fn dismiss_job(&self, version: &str) -> Result<(), String> {
    let v = normalize_version(version);
    let mut g = self.jobs.lock().await;
    let phase = g
      .get(&v)
      .map(|e| e.payload.phase.as_str())
      .ok_or_else(|| "No hay registro para esa versión.".to_string())?;
    if !matches!(phase, "failed" | "cancelled") {
      return Err("Solo pueden descartarse tareas canceladas o con error.".to_string());
    }
    g.remove(&v);
    Ok(())
  }

  pub async fn start_download(&self, app: tauri::AppHandle, version_raw: String) -> Result<(), String> {
    use crate::app_config::load_config;
    use crate::node_manager::is_version_installed;

    let normalized = normalize_version(&version_raw);
    let cfg = load_config()?;
    let repo = PathBuf::from(&cfg.repository_path);
    std::fs::create_dir_all(&repo).map_err(|e| format!("Repositorio: {e}"))?;

    if is_version_installed(repo.as_path(), &normalized) {
      return Err("La versión ya está instalada.".to_string());
    }

    let mut g = self.jobs.lock().await;
    if g.contains_key(&normalized) {
      return Err("Ya hay una descarga en curso o pendiente para esta versión.".to_string());
    }
    let cancel = CancellationToken::new();
    g.insert(
      normalized.clone(),
      JobEntry {
        payload: DownloadJobPayload {
          version: normalized.clone(),
          phase: "queued".into(),
          message: None,
          received_bytes: 0,
          total_bytes: None,
        },
        cancel: cancel.clone(),
      },
    );
    drop(g);

    let svc = self.clone_for_spawn();
    let version_cl = normalized.clone();
    let repo_for_cleanup = repo.clone();

    tauri::async_runtime::spawn(async move {
      let result =
        Self::download_run(app.clone(), svc.clone(), repo, version_cl.clone(), cancel.clone()).await;
      match result {
        Ok(()) => {
          let mut g = svc.jobs.lock().await;
          g.remove(&version_cl);
          drop(g);
          let _ = app.emit("download-complete", &version_cl);
        }
        Err(e) => {
          let cancelled = cancel.is_cancelled();
          cleanup_failed_download(&repo_for_cleanup, &version_cl);
          svc
            .notify(
              &app,
              &version_cl,
              if cancelled { "cancelled" } else { "failed" },
              Some(if cancelled {
                "Descarga cancelada.".into()
              } else {
                e
              }),
              0,
              None,
            )
            .await;
        }
      }
    });

    Ok(())
  }

  fn clone_for_spawn(&self) -> Self {
    Self {
      jobs: Arc::clone(&self.jobs),
    }
  }

  async fn download_run(
    app: tauri::AppHandle,
    svc: DownloadService,
    repo: PathBuf,
    normalized: String,
    cancel: CancellationToken,
  ) -> Result<(), String> {
    use crate::app_config::load_config;
    use crate::node_manager::{
      detect_target, extract_unix_tar_xz, extract_windows_zip, generate_node_set_script, node_exec,
      version_dir,
    };

    svc
      .notify(
        &app,
        &normalized,
        "queued",
        Some("En cola…".into()),
        0,
        None,
      )
      .await;

    svc
      .notify(
        &app,
        &normalized,
        "resolving",
        Some("Consultando índice oficial…".into()),
        0,
        None,
      )
      .await;

    let cfg = load_config()?;
    let client = build_async_client(&cfg.proxy)?;
    let available = fetch_available_versions_async(&client).await?;
    if !available.contains(&normalized) {
      return Err(format!("La versión {normalized} no existe en el índice oficial."));
    }

    if cancel.is_cancelled() {
      return Err("Descarga cancelada.".into());
    }

    svc
      .notify(
        &app,
        &normalized,
        "downloading",
        Some("Descargando…".into()),
        0,
        None,
      )
      .await;

    let (target_os, target_arch, ext) = detect_target();
    let artifact = format!("node-v{normalized}-{target_os}-{target_arch}.{ext}");
    let url = format!("{NODE_DIST_BASE}/v{normalized}/{artifact}");
    let partial_path = repo.join(format!("{artifact}.partial"));
    let temp_file = repo.join(&artifact);

    if partial_path.exists() {
      let _ = std::fs::remove_file(&partial_path);
    }
    if temp_file.exists() {
      let _ = std::fs::remove_file(&temp_file);
    }

    let res = client.get(&url).send().await.map_err(|e| format!("Red: {e}"))?;
    if !res.status().is_success() {
      return Err(format!("HTTP al descargar ({})", res.status()));
    }

    let total = res.content_length();
    let mut stream = res.bytes_stream();
    let mut file = tokio::fs::File::create(&partial_path)
      .await
      .map_err(|e| format!("Archivo temporal: {e}"))?;
    let mut received: u64 = 0;
    let mut last_emit = 0u64;

    while let Some(item) = stream.next().await {
      if cancel.is_cancelled() {
        drop(file);
        let _ = tokio::fs::remove_file(&partial_path).await;
        return Err("Descarga cancelada.".into());
      }
      let chunk = item.map_err(|e| format!("Lectura: {e}"))?;
      file
        .write_all(&chunk)
        .await
        .map_err(|e| format!("Escritura: {e}"))?;
      received += chunk.len() as u64;
      if received.saturating_sub(last_emit) >= 262_144 {
        svc
          .notify(&app, &normalized, "downloading", None, received, total)
          .await;
        last_emit = received;
      }
    }

    svc
      .notify(
        &app,
        &normalized,
        "verifying",
        Some("Verificando SHA256…".into()),
        received,
        total,
      )
      .await;

    let sums_txt = download_checksums(&client, &normalized).await?;
    verify_checksum_sync(&sums_txt, &artifact, &partial_path)?;

    tokio::fs::rename(&partial_path, &temp_file)
      .await
      .map_err(|e| format!("Renombrar descarga: {e}"))?;

    if cancel.is_cancelled() {
      let _ = tokio::fs::remove_file(&temp_file).await;
      return Err("Descarga cancelada.".into());
    }

    svc
      .notify(
        &app,
        &normalized,
        "extracting",
        Some("Extrayendo instalación…".into()),
        received,
        total,
      )
      .await;

    let out_dir = version_dir(repo.as_path(), &normalized);
    if out_dir.exists() {
      if node_exec(&out_dir).exists() {
        let _ = std::fs::remove_dir_all(&out_dir);
      } else {
        let _ = std::fs::remove_dir_all(&out_dir);
      }
    }

    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Crear carpeta versión: {e}"))?;

    let zp = temp_file.clone();
    let od = out_dir.clone();
    let extract_ok = tokio::task::spawn_blocking(move || {
      if cfg!(target_os = "windows") {
        extract_windows_zip(&zp, &od)
      } else {
        extract_unix_tar_xz(&zp, &od)
      }
    })
    .await
    .map_err(|_| "Extracción interrumpida.".to_string())?;

    extract_ok?;

    flatten_extracted_folder(&out_dir)?;

    std::fs::remove_file(&temp_file).unwrap_or_default();

    if cancel.is_cancelled() {
      let _ = std::fs::remove_dir_all(&out_dir);
      return Err("Descarga cancelada.".into());
    }

    generate_node_set_script()?;
    svc
      .notify(
        &app,
        &normalized,
        "complete",
        Some("Instalación finalizada.".into()),
        received,
        total,
      )
      .await;

    Ok(())
  }
}

#[derive(Clone, Deserialize)]
struct IndexEntry {
  version: String,
}

fn env_non_empty(primary: &str, secondary: &str) -> Option<String> {
  std::env::var(primary)
    .ok()
    .or_else(|| std::env::var(secondary).ok())
    .and_then(|s| {
      let t = s.trim();
      (!t.is_empty()).then(|| t.to_string())
    })
}

fn resolved_http_proxy(cfg: &ProxyConfig) -> Option<String> {
  if !cfg.enabled {
    return None;
  }
  if cfg.use_env_http_proxy {
    env_non_empty("HTTP_PROXY", "http_proxy")
  } else {
    cfg
      .http_proxy
      .as_ref()
      .map(|s| s.trim())
      .filter(|s| !s.is_empty())
      .map(str::to_string)
  }
}

fn resolved_https_proxy(cfg: &ProxyConfig) -> Option<String> {
  if !cfg.enabled {
    return None;
  }
  if cfg.use_env_https_proxy {
    env_non_empty("HTTPS_PROXY", "https_proxy")
  } else {
    cfg
      .https_proxy
      .as_ref()
      .map(|s| s.trim())
      .filter(|s| !s.is_empty())
      .map(str::to_string)
  }
}

fn resolved_no_proxy_list(cfg: &ProxyConfig) -> Option<NoProxy> {
  if !cfg.enabled {
    return None;
  }
  let raw = if cfg.use_env_no_proxy {
    env_non_empty("NO_PROXY", "no_proxy")
  } else {
    cfg
      .no_proxy
      .as_ref()
      .map(|s| s.trim())
      .filter(|s| !s.is_empty())
      .map(str::to_string)
  }?;
  NoProxy::from_string(&raw)
}

fn build_async_client(proxy_cfg: &ProxyConfig) -> Result<reqwest::Client, String> {
  let mut builder = reqwest::Client::builder();
  if proxy_cfg.enabled {
    let no_np = resolved_no_proxy_list(proxy_cfg);

    if let Some(url) = resolved_http_proxy(proxy_cfg) {
      let mut px = ReqwestProxy::http(&url).map_err(|e| format!("Proxy HTTP inválido: {e}"))?;
      if let Some(np) = &no_np {
        px = px.no_proxy(Some(np.clone()));
      }
      builder = builder.proxy(px);
    }
    if let Some(url) = resolved_https_proxy(proxy_cfg) {
      let mut px =
        ReqwestProxy::https(&url).map_err(|e| format!("Proxy HTTPS inválido: {e}"))?;
      if let Some(np) = &no_np {
        px = px.no_proxy(Some(np.clone()));
      }
      builder = builder.proxy(px);
    }
  }
  builder
    .build()
    .map_err(|e| format!("No se pudo crear cliente HTTP: {e}"))
}

async fn fetch_available_versions_async(client: &reqwest::Client) -> Result<Vec<String>, String> {
  let url = format!("{NODE_DIST_BASE}/index.json");
  let res = client
    .get(&url)
    .send()
    .await
    .map_err(|e| format!("index.json: {e}"))?;
  if !res.status().is_success() {
    return Err(format!("index.json HTTP {}", res.status()));
  }
  let txt = res.text().await.map_err(|e| format!("index.json texto: {e}"))?;
  let entries: Vec<IndexEntry> = serde_json::from_str(&txt).map_err(|e| format!("JSON: {e}"))?;
  Ok(entries
    .into_iter()
    .map(|e| normalize_version(&e.version))
    .collect())
}

async fn download_checksums(client: &reqwest::Client, version: &str) -> Result<String, String> {
  let url = format!("{NODE_DIST_BASE}/v{version}/SHASUMS256.txt");
  let res = client.get(&url).send().await.map_err(|e| format!("Checksums: {e}"))?;
  if !res.status().is_success() {
    return Err(format!("Checksums HTTP {}", res.status()));
  }
  res.text().await.map_err(|e| format!("Checksums texto: {e}"))
}

fn verify_checksum_sync(checksums: &str, filename: &str, file_path: &Path) -> Result<(), String> {
  let expected = checksums
    .lines()
    .find_map(|line| {
      let parts = line.split_whitespace().collect::<Vec<_>>();
      if parts.len() >= 2 && parts[1].trim() == filename {
        Some(parts[0].to_lowercase())
      } else {
        None
      }
    })
    .ok_or_else(|| "Sin entrada de checksum.".to_string())?;

  let mut file = std::fs::File::open(file_path).map_err(|e| format!("Leer archivo: {e}"))?;
  let mut hasher = Sha256::new();
  let mut buf = [0_u8; 65536];
  loop {
    let n = Read::read(&mut file, &mut buf).map_err(|e| format!("Checksum read: {e}"))?;
    if n == 0 {
      break;
    }
    hasher.update(&buf[..n]);
  }
  let got = format!("{:x}", hasher.finalize());
  if got != expected {
    return Err("Checksum SHA256 incorrecto.".into());
  }
  Ok(())
}
