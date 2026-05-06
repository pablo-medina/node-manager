use dirs::{config_dir, home_dir};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProxyConfig {
  pub enabled: bool,
  /// Si está activo, sólo se usa `HTTP_PROXY` / `http_proxy` del sistema.
  pub use_env_http_proxy: bool,
  /// Si está activo, sólo se usa `HTTPS_PROXY` / `https_proxy` del sistema.
  pub use_env_https_proxy: bool,
  /// Si está activo, sólo se usa `NO_PROXY` / `no_proxy` del sistema.
  pub use_env_no_proxy: bool,
  pub http_proxy: Option<String>,
  pub https_proxy: Option<String>,
  pub no_proxy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiConfig {
  pub theme: String,
}

impl Default for UiConfig {
  fn default() -> Self {
    Self {
      theme: "system".to_string(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
  pub base_dir: String,
  pub repository_path: String,
  pub proxy: ProxyConfig,
  pub ui: UiConfig,
}

fn default_base_dir() -> PathBuf {
  if cfg!(target_os = "windows") {
    PathBuf::from("C:\\node-manager")
  } else {
    home_dir()
      .unwrap_or_else(|| PathBuf::from("."))
      .join(".node-manager")
  }
}

impl Default for AppConfig {
  fn default() -> Self {
    let base = default_base_dir();
    let repo = base.join("repository");
    Self {
      base_dir: base.to_string_lossy().to_string(),
      repository_path: repo.to_string_lossy().to_string(),
      proxy: ProxyConfig::default(),
      ui: UiConfig::default(),
    }
  }
}

pub fn config_file_path() -> Result<PathBuf, String> {
  let base = config_dir()
    .unwrap_or_else(|| PathBuf::from("."))
    .join("node-manager");
  fs::create_dir_all(&base).map_err(|e| format!("No se pudo crear config dir: {e}"))?;
  Ok(base.join("config.json"))
}

pub fn ensure_default_config() -> Result<(), String> {
  let path = config_file_path()?;
  if !path.exists() {
    let cfg = AppConfig::default();
    save_config(&cfg)?;
  } else {
    let cfg = load_config()?;
    ensure_storage_dirs(&cfg)?;
  }
  Ok(())
}

pub fn load_config() -> Result<AppConfig, String> {
  let path = config_file_path()?;
  if !path.exists() {
    let cfg = AppConfig::default();
    save_config(&cfg)?;
    return Ok(cfg);
  }
  let txt = fs::read_to_string(&path).map_err(|e| format!("No se pudo leer config: {e}"))?;
  let cfg: AppConfig = serde_json::from_str(&txt).map_err(|e| format!("JSON inválido: {e}"))?;
  ensure_storage_dirs(&cfg)?;
  Ok(cfg)
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
  ensure_storage_dirs(config)?;
  let path = config_file_path()?;
  let txt = serde_json::to_string_pretty(config).map_err(|e| format!("No se pudo serializar config: {e}"))?;
  fs::write(path, txt).map_err(|e| format!("No se pudo escribir config: {e}"))
}

pub fn update_proxy(proxy: ProxyConfig) -> Result<AppConfig, String> {
  let mut cfg = load_config()?;
  cfg.proxy = proxy;
  save_config(&cfg)?;
  Ok(cfg)
}

pub fn ensure_storage_dirs(cfg: &AppConfig) -> Result<(), String> {
  let base = Path::new(&cfg.base_dir);
  let repo = Path::new(&cfg.repository_path);
  fs::create_dir_all(base).map_err(|e| format!("No se pudo crear base_dir: {e}"))?;
  fs::create_dir_all(repo).map_err(|e| format!("No se pudo crear repository_path: {e}"))?;
  Ok(())
}
