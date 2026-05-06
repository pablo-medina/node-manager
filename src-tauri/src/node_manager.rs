use crate::app_config::load_config;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{self};
use std::path::{Path, PathBuf};
use std::process::Command;
use tar::Archive;
use walkdir::WalkDir;
use xz2::read::XzDecoder;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeVersionInfo {
  pub version: String,
  pub path: String,
  pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskUsageReport {
  pub total_bytes: u64,
  pub versions: Vec<NodeVersionInfo>,
  /// `false`: enumeración rápida (solo carpetas), sin tamaños en disco.
  #[serde(default)]
  pub sizes_known: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanCandidate {
  pub version: String,
  pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanReport {
  pub candidates: Vec<ScanCandidate>,
}

pub(crate) fn detect_target() -> (&'static str, &'static str, &'static str) {
  let os = if cfg!(target_os = "windows") {
    "win"
  } else if cfg!(target_os = "macos") {
    "darwin"
  } else {
    "linux"
  };
  let arch = if cfg!(target_arch = "x86_64") {
    "x64"
  } else if cfg!(target_arch = "aarch64") {
    "arm64"
  } else {
    "x64"
  };
  let ext = if cfg!(target_os = "windows") { "zip" } else { "tar.xz" };
  (os, arch, ext)
}

fn binary_name() -> &'static str {
  if cfg!(target_os = "windows") {
    "node.exe"
  } else {
    "node"
  }
}

pub(crate) fn node_exec(version_dir: &Path) -> PathBuf {
  if cfg!(target_os = "windows") {
    version_dir.join("node.exe")
  } else {
    version_dir.join("bin").join("node")
  }
}

pub(crate) fn normalize_version(version: &str) -> String {
  version.trim().trim_start_matches('v').to_string()
}

pub(crate) fn version_dir(repo: &Path, version: &str) -> PathBuf {
  repo.join(normalize_version(version))
}

fn dir_size(path: &Path) -> u64 {
  WalkDir::new(path)
    .into_iter()
    .filter_map(Result::ok)
    .filter_map(|entry| entry.metadata().ok())
    .filter(|meta| meta.is_file())
    .map(|meta| meta.len())
    .sum()
}

fn read_package_json_name(pkg_dir: &Path) -> Option<String> {
  let txt = fs::read_to_string(pkg_dir.join("package.json")).ok()?;
  let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
  Some(v.get("name")?.as_str()?.to_owned())
}

/// Paquetes de primer nivel encontrados en `node_modules` (y `lib/node_modules`).
/// Equivalente práctico a listar carpetas con `package.json`; con scopes (`@a/b`).
/// No ejecuta npm: si el `prefix -g` apunta fuera de esta instalación (típico en Windows global),
/// esos paquetes no estarán aquí — es una limitación de cualquier vista basada sólo en el árbol de archivos.
fn list_global_packages_from_install_layout(version_path: &Path) -> Vec<String> {
  use std::collections::BTreeSet;
  let roots = [
    version_path.join("node_modules"),
    version_path.join("lib").join("node_modules"),
  ];
  let mut names = BTreeSet::new();

  for nm in roots {
    if !nm.is_dir() {
      continue;
    }
    let Ok(entries) = fs::read_dir(&nm) else {
      continue;
    };
    for entry in entries.filter_map(Result::ok) {
      let p = entry.path();
      if !p.is_dir() {
        continue;
      }
      let seg = entry.file_name();
      let seg_s = seg.to_string_lossy();
      if seg_s.starts_with('.') {
        continue;
      }
      if seg_s.starts_with('@') {
        let Ok(scope_entries) = fs::read_dir(&p) else {
          continue;
        };
        for sub in scope_entries.filter_map(Result::ok) {
          let sp = sub.path();
          if !sp.is_dir() {
            continue;
          }
          let label = read_package_json_name(&sp).unwrap_or_else(|| {
            format!(
              "{}/{}",
              seg_s,
              sub.file_name().to_string_lossy()
            )
          });
          names.insert(label);
        }
        continue;
      }
      let label =
        read_package_json_name(&p).unwrap_or_else(|| seg_s.to_string());
      names.insert(label);
    }
  }

  names.into_iter().collect()
}

pub(crate) fn extract_windows_zip(zip_file: &Path, out_dir: &Path) -> Result<(), String> {
  let file = fs::File::open(zip_file).map_err(|e| format!("No se pudo abrir ZIP: {e}"))?;
  let mut archive = ZipArchive::new(file).map_err(|e| format!("ZIP inválido: {e}"))?;
  for i in 0..archive.len() {
    let mut entry = archive.by_index(i).map_err(|e| format!("No se pudo leer ZIP entry: {e}"))?;
    let safe_name = entry
      .enclosed_name()
      .map(|p| p.to_owned())
      .unwrap_or_else(|| PathBuf::from(entry.name()));
    let outpath = out_dir.join(safe_name);
    if entry.name().ends_with('/') {
      fs::create_dir_all(&outpath).map_err(|e| format!("No se pudo crear directorio: {e}"))?;
    } else {
      if let Some(parent) = outpath.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear directorio: {e}"))?;
      }
      let mut outfile = fs::File::create(&outpath).map_err(|e| format!("No se pudo crear archivo: {e}"))?;
      io::copy(&mut entry, &mut outfile).map_err(|e| format!("No se pudo extraer archivo: {e}"))?;
    }
  }
  Ok(())
}

pub(crate) fn extract_unix_tar_xz(archive_file: &Path, out_dir: &Path) -> Result<(), String> {
  let file = fs::File::open(archive_file).map_err(|e| format!("No se pudo abrir tar.xz: {e}"))?;
  let decoder = XzDecoder::new(file);
  let mut archive = Archive::new(decoder);
  archive.unpack(out_dir).map_err(|e| format!("No se pudo extraer tar.xz: {e}"))
}

pub(crate) fn flatten_extracted_folder(version_output_dir: &Path) -> Result<(), String> {
  let children = fs::read_dir(version_output_dir)
    .map_err(|e| format!("No se pudo leer directorio extraído: {e}"))?
    .filter_map(Result::ok)
    .map(|e| e.path())
    .collect::<Vec<_>>();
  if children.len() == 1 && children[0].is_dir() {
    let inner = children[0].clone();
    for entry in fs::read_dir(&inner).map_err(|e| format!("No se pudo leer subdirectorio extraído: {e}"))? {
      let path = entry.map_err(|e| format!("Entrada inválida: {e}"))?.path();
      let target = version_output_dir.join(
        path
          .file_name()
          .ok_or_else(|| "Nombre de archivo inválido".to_string())?,
      );
      fs::rename(&path, target).map_err(|e| format!("No se pudo mover archivo extraído: {e}"))?;
    }
    fs::remove_dir_all(inner).map_err(|e| format!("No se pudo limpiar directorio temporal: {e}"))?;
  }
  Ok(())
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
  fs::create_dir_all(to).map_err(|e| format!("No se pudo crear destino: {e}"))?;
  for entry in WalkDir::new(from).into_iter().filter_map(Result::ok) {
    let rel = entry.path().strip_prefix(from).map_err(|e| format!("Ruta inválida: {e}"))?;
    let dest = to.join(rel);
    if entry.file_type().is_dir() {
      fs::create_dir_all(&dest).map_err(|e| format!("No se pudo crear directorio: {e}"))?;
    } else {
      if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear directorio padre: {e}"))?;
      }
      fs::copy(entry.path(), &dest).map_err(|e| format!("No se pudo copiar archivo: {e}"))?;
    }
  }
  Ok(())
}

pub(crate) fn is_version_installed(repo: &Path, version: &str) -> bool {
  node_exec(&version_dir(repo, version)).exists()
}

/// Lista subcarpetas del repositorio como versiones instaladas (sin recorrer disco ni lanzar npm).
pub fn list_installed_versions() -> Result<Vec<NodeVersionInfo>, String> {
  enumerate_repo_version_dirs_quick()
}

fn enumerate_repo_version_dirs_quick() -> Result<Vec<NodeVersionInfo>, String> {
  let cfg = load_config()?;
  let repo = Path::new(&cfg.repository_path);
  let mut items = Vec::new();
  if !repo.exists() {
    return Ok(items);
  }
  for entry in fs::read_dir(repo).map_err(|e| format!("No se pudo listar repositorio: {e}"))? {
    let p = entry.map_err(|e| format!("Entrada inválida: {e}"))?.path();
    if !p.is_dir() {
      continue;
    }
    let version = p
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_else(|| "desconocida".to_string());
    items.push(NodeVersionInfo {
      version,
      path: p.to_string_lossy().to_string(),
      size_bytes: 0,
    });
  }
  items.sort_by(|a, b| b.version.cmp(&a.version));
  Ok(items)
}

fn list_installed_versions_measured() -> Result<Vec<NodeVersionInfo>, String> {
  let cfg = load_config()?;
  let repo = Path::new(&cfg.repository_path);
  let mut items = Vec::new();
  if !repo.exists() {
    return Ok(items);
  }
  for entry in fs::read_dir(repo).map_err(|e| format!("No se pudo listar repositorio: {e}"))? {
    let p = entry.map_err(|e| format!("Entrada inválida: {e}"))?.path();
    if !p.is_dir() {
      continue;
    }
    if !node_exec(&p).exists() {
      continue;
    }
    let version = p
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_else(|| "desconocida".to_string());
    items.push(NodeVersionInfo {
      version,
      path: p.to_string_lossy().to_string(),
      size_bytes: dir_size(&p),
    });
  }
  items.sort_by(|a, b| b.version.cmp(&a.version));
  Ok(items)
}

pub fn generate_node_set_script() -> Result<String, String> {
  let cfg = load_config()?;
  let base = Path::new(&cfg.base_dir);
  fs::create_dir_all(base).map_err(|e| format!("No se pudo crear base_dir: {e}"))?;
  if cfg!(target_os = "windows") {
    let script = r#"@echo off
setlocal
if "%~1"=="" (
  echo Uso: node-set.cmd ^<version^>
  exit /b 1
)
set "NODEMGR_BASE=%~dp0"
set "NODEMGR_REPO=%NODEMGR_BASE%repository"
set "NODE_VERSION=%~1"
set "NODE_BIN=%NODEMGR_REPO%\%NODE_VERSION%"
if not exist "%NODE_BIN%\node.exe" (
  echo Version no instalada: %NODE_VERSION%
  exit /b 1
)
set "PATH=%NODE_BIN%;%PATH%"
echo Node activado: %NODE_VERSION%
node -v
"#;
    let path = base.join("node-set.cmd");
    fs::write(&path, script).map_err(|e| format!("No se pudo escribir node-set.cmd: {e}"))?;
    Ok(path.to_string_lossy().to_string())
  } else {
    let script = r#"#!/usr/bin/env sh
if [ -z "$1" ]; then
  echo "Uso: source ./node-set.sh <version>"
  return 1 2>/dev/null || exit 1
fi
NODEMGR_BASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE_VERSION="$1"
NODE_BIN="$NODEMGR_BASE/repository/$NODE_VERSION/bin"
if [ ! -x "$NODE_BIN/node" ]; then
  echo "Version no instalada: $NODE_VERSION"
  return 1 2>/dev/null || exit 1
fi
export PATH="$NODE_BIN:$PATH"
echo "Node activado: $NODE_VERSION"
node -v
"#;
    let path = base.join("node-set.sh");
    fs::write(&path, script).map_err(|e| format!("No se pudo escribir node-set.sh: {e}"))?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mut perms = fs::metadata(&path).map_err(|e| format!("No se pudo leer permisos: {e}"))?.permissions();
      perms.set_mode(0o755);
      fs::set_permissions(&path, perms).map_err(|e| format!("No se pudo setear permisos: {e}"))?;
    }
    Ok(path.to_string_lossy().to_string())
  }
}

/// Resumen rápido para arranque: sólo cuenta carpetas, sin tamaños ni `npm ls`.
pub fn disk_usage_report() -> Result<DiskUsageReport, String> {
  let versions = enumerate_repo_version_dirs_quick()?;
  Ok(DiskUsageReport {
    total_bytes: 0,
    versions,
    sizes_known: false,
  })
}

/// Tamaños en disco por versión (recorre archivos; sin invocar npm).
pub fn disk_usage_report_detailed() -> Result<DiskUsageReport, String> {
  let versions = list_installed_versions_measured()?;
  let total = versions.iter().map(|v| v.size_bytes).sum();
  Ok(DiskUsageReport {
    total_bytes: total,
    versions,
    sizes_known: true,
  })
}

pub fn scan_external_nodes() -> Result<ScanReport, String> {
  let cfg = load_config()?;
  let repo = Path::new(&cfg.repository_path).to_path_buf();
  let mut roots: Vec<PathBuf> = Vec::new();

  if cfg!(target_os = "windows") {
    roots.push(PathBuf::from("C:\\Program Files\\nodejs"));
    roots.push(PathBuf::from("C:\\Program Files (x86)\\nodejs"));
    if let Some(home) = dirs::home_dir() {
      roots.push(home.join("AppData").join("Roaming").join("nvm"));
      roots.push(home.join("scoop").join("apps").join("nodejs"));
    }
  } else {
    roots.push(PathBuf::from("/usr/local"));
    roots.push(PathBuf::from("/opt"));
    if let Some(home) = dirs::home_dir() {
      roots.push(home.join(".nvm"));
      roots.push(home.join(".asdf"));
    }
  }

  let mut seen = HashSet::<String>::new();
  let mut candidates = Vec::new();
  for root in roots.into_iter().filter(|p| p.exists()) {
    for entry in WalkDir::new(&root)
      .max_depth(6)
      .into_iter()
      .filter_map(Result::ok)
      .filter(|e| e.file_type().is_file() && e.file_name().to_string_lossy().eq_ignore_ascii_case(binary_name()))
    {
      let parent = entry.path().parent().unwrap_or(entry.path()).to_path_buf();
      let node_path = if cfg!(target_os = "windows") {
        parent.join("node.exe")
      } else {
        parent.join("node")
      };
      let output = Command::new(&node_path).arg("-v").output();
      if let Ok(out) = output {
        if out.status.success() {
          let version = normalize_version(String::from_utf8_lossy(&out.stdout).trim());
          if version.is_empty() {
            continue;
          }
          if is_version_installed(&repo, &version) {
            continue;
          }
          let key = format!("{}|{}", version, parent.to_string_lossy());
          if seen.insert(key) {
            candidates.push(ScanCandidate {
              version,
              path: parent.to_string_lossy().to_string(),
            });
          }
        }
      }
    }
  }
  candidates.sort_by(|a, b| a.version.cmp(&b.version));
  Ok(ScanReport { candidates })
}

pub fn delete_installed_version(version: &str) -> Result<(), String> {
  let cfg = load_config()?;
  let repo = Path::new(&cfg.repository_path);
  let normalized = normalize_version(version);
  let target = version_dir(repo, &normalized);
  if !node_exec(&target).exists() {
    return Err("La versión no está instalada o la ruta no es válida.".to_string());
  }
  fs::remove_dir_all(&target).map_err(|e| format!("No se pudo eliminar la versión: {e}"))?;
  Ok(())
}

pub fn import_external_node(path: &str, version: &str) -> Result<NodeVersionInfo, String> {
  let cfg = load_config()?;
  let repo = Path::new(&cfg.repository_path);
  let source = Path::new(path);
  let normalized = normalize_version(version);
  let target = version_dir(repo, &normalized);
  if !source.exists() {
    return Err("La ruta origen no existe".to_string());
  }
  if target.exists() {
    return Err("La versión ya existe en el repositorio local".to_string());
  }
  copy_dir_recursive(source, &target)?;
  if !node_exec(&target).exists() {
    let _ = fs::remove_dir_all(&target);
    return Err("La ruta importada no parece una instalación válida de Node".to_string());
  }
  generate_node_set_script()?;
  Ok(NodeVersionInfo {
    version: normalized,
    path: target.to_string_lossy().to_string(),
    size_bytes: dir_size(&target),
  })
}

/// Paquetes bajo los `node_modules` de esa instalación (sin subprocess npm).
pub fn list_global_npm_packages_for_managed_install(version_path_str: String) -> Result<Vec<String>, String> {
  let cfg = load_config()?;
  let repo = fs::canonicalize(Path::new(&cfg.repository_path))
    .map_err(|_| "No se pudo resolver la ruta del repositorio local.".to_string())?;
  let target = fs::canonicalize(Path::new(&version_path_str))
    .map_err(|_| "No se pudo resolver la carpeta de la instalación.".to_string())?;
  if !target.starts_with(&repo) {
    return Err("La instalación no pertenece al repositorio gestionado.".to_string());
  }
  if !target.is_dir() {
    return Err("La ruta no es un directorio.".to_string());
  }
  Ok(list_global_packages_from_install_layout(&target))
}

pub fn open_path_in_explorer(path: &str) -> Result<(), String> {
  let p = Path::new(path);
  if !p.is_dir() {
    return Err("La ruta no es un directorio existente.".to_string());
  }
  let canon = fs::canonicalize(p).map_err(|e| format!("No se pudo resolver la carpeta: {e}"))?;
  #[cfg(target_os = "windows")]
  {
    return Command::new("explorer.exe")
      .arg(canon.as_os_str())
      .spawn()
      .map_err(|e| format!("No se pudo abrir el explorador: {e}"))
      .map(|_| ());
  }
  #[cfg(target_os = "macos")]
  {
    return Command::new("open")
      .arg(canon.as_os_str())
      .spawn()
      .map_err(|e| format!("No se pudo abrir Finder: {e}"))
      .map(|_| ());
  }
  #[cfg(all(unix, not(target_os = "macos")))]
  {
    return Command::new("xdg-open")
      .arg(canon.as_os_str())
      .spawn()
      .map_err(|e| format!("No se pudo abrir el gestor de archivos: {e}"))
      .map(|_| ());
  }
  #[cfg(not(any(unix, target_os = "windows", target_os = "macos")))]
  {
    Err("Apertura de carpeta no soportada en esta plataforma.".to_string())
  }
}
