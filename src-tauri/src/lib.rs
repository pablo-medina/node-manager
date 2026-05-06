mod app_config;
mod downloads;
mod node_manager;

use app_config::ProxyConfig;
use downloads::{DownloadJobPayload, DownloadService};
use node_manager::{DiskUsageReport, NodeVersionInfo, ScanReport};
use tauri::Manager;

#[tauri::command]
fn get_settings() -> Result<app_config::AppConfig, String> {
  app_config::load_config()
}

#[tauri::command]
fn save_settings(config: app_config::AppConfig) -> Result<app_config::AppConfig, String> {
  app_config::save_config(&config)?;
  Ok(config)
}

#[tauri::command]
fn set_proxy(proxy: ProxyConfig) -> Result<app_config::AppConfig, String> {
  app_config::update_proxy(proxy)
}

#[tauri::command]
fn list_installed_versions() -> Result<Vec<NodeVersionInfo>, String> {
  node_manager::list_installed_versions()
}

#[tauri::command]
async fn start_background_install(version: String, app: tauri::AppHandle) -> Result<(), String> {
  let svc = app.state::<DownloadService>();
  svc.start_download(app.clone(), version).await
}

#[tauri::command]
async fn cancel_background_install(version: String, app: tauri::AppHandle) -> Result<(), String> {
  let svc = app.state::<DownloadService>();
  svc.cancel(&version).await
}

#[tauri::command]
async fn list_download_jobs(app: tauri::AppHandle) -> Result<Vec<DownloadJobPayload>, String> {
  let svc = app.state::<DownloadService>();
  Ok(svc.list_jobs().await)
}

#[tauri::command]
async fn dismiss_download_job(version: String, app: tauri::AppHandle) -> Result<(), String> {
  let svc = app.state::<DownloadService>();
  svc.dismiss_job(&version).await
}

#[tauri::command]
async fn retry_background_install(version: String, app: tauri::AppHandle) -> Result<(), String> {
  let svc = app.state::<DownloadService>();
  svc.dismiss_job(&version).await?;
  svc.start_download(app.clone(), version).await
}

#[tauri::command]
fn delete_installed_version(version: String) -> Result<(), String> {
  node_manager::delete_installed_version(&version)
}

#[tauri::command]
fn open_version_folder(path: String) -> Result<(), String> {
  node_manager::open_path_in_explorer(&path)
}

#[tauri::command]
fn generate_node_set_script() -> Result<String, String> {
  node_manager::generate_node_set_script()
}

#[tauri::command]
fn disk_usage_report() -> Result<DiskUsageReport, String> {
  node_manager::disk_usage_report()
}

#[tauri::command]
async fn disk_usage_report_detailed() -> Result<DiskUsageReport, String> {
  tokio::task::spawn_blocking(|| node_manager::disk_usage_report_detailed())
    .await
    .map_err(|e| format!("Error interno: {e}"))?
}

#[tauri::command]
fn scan_external_nodes() -> Result<ScanReport, String> {
  node_manager::scan_external_nodes()
}

#[tauri::command]
fn import_external_node(path: String, version: String) -> Result<NodeVersionInfo, String> {
  node_manager::import_external_node(&path, &version)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn list_global_npm_packages(versionPath: String) -> Result<Vec<String>, String> {
  tokio::task::spawn_blocking(move || node_manager::list_global_npm_packages_for_managed_install(versionPath))
    .await
    .map_err(|e| format!("Error interno: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      get_settings,
      save_settings,
      set_proxy,
      list_installed_versions,
      start_background_install,
      cancel_background_install,
      list_download_jobs,
      dismiss_download_job,
      retry_background_install,
      delete_installed_version,
      open_version_folder,
      generate_node_set_script,
      disk_usage_report,
      disk_usage_report_detailed,
      scan_external_nodes,
      import_external_node,
      list_global_npm_packages,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.manage(DownloadService::new());
      app_config::ensure_default_config()?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
