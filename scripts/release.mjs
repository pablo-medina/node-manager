import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const releasesDir = path.join(rootDir, "releases");

const bumpArg = process.argv.find((arg) => arg.startsWith("--bump="));
const bumpType = bumpArg ? bumpArg.split("=")[1] : "patch";
const shouldPublish = process.argv.includes("--publish");

const validBumps = new Set(["major", "minor", "patch"]);
if (!validBumps.has(bumpType)) {
  console.error(`Tipo de bump invalido: ${bumpType}`);
  console.error("Usa --bump=major | --bump=minor | --bump=patch");
  process.exit(1);
}

function bumpVersion(version, type) {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Version invalida: ${version}`);
  }

  const [major, minor, patch] = parts;
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function updatePackageJson(newVersion) {
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const data = JSON.parse(raw);
  data.version = newVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function updateTauriConfig(newVersion) {
  const raw = fs.readFileSync(tauriConfigPath, "utf8");
  const data = JSON.parse(raw);
  data.version = newVersion;
  fs.writeFileSync(tauriConfigPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function updateCargoToml(newVersion) {
  const raw = fs.readFileSync(cargoTomlPath, "utf8");
  const updated = raw.replace(
    /^version\s*=\s*"[0-9]+\.[0-9]+\.[0-9]+"$/m,
    `version = "${newVersion}"`
  );

  if (updated === raw) {
    throw new Error("No se pudo actualizar la version en Cargo.toml");
  }

  fs.writeFileSync(cargoTomlPath, updated, "utf8");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function run(command) {
  execSync(command, { stdio: "inherit" });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getArchLabel() {
  const archMap = {
    x64: "x64",
    arm64: "arm64",
    ia32: "x86",
  };

  return archMap[process.arch] ?? process.arch;
}

function collectReleaseArtifacts(bundleDir, version, arch) {
  const versionPattern = new RegExp(`(^|[^0-9])${escapeRegex(version)}([^0-9]|$)`, "i");
  const archPattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(arch)}([^a-z0-9]|$)`, "i");
  const artifacts = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileName = entry.name.toLowerCase();
      if (versionPattern.test(fileName) && archPattern.test(fileName)) {
        artifacts.push(fullPath);
      }
    }
  }

  walk(bundleDir);
  return artifacts;
}

function removeDirIfExists(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function buildZipFromArtifacts(artifacts, stagingDir, zipPath) {
  removeDirIfExists(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const artifact of artifacts) {
    const destination = path.join(stagingDir, path.basename(artifact));
    fs.copyFileSync(artifact, destination);
  }

  const psStagingDir = stagingDir.replace(/\\/g, "\\\\");
  const psZipPath = zipPath.replace(/\\/g, "\\\\");
  const psCommand = `& { Compress-Archive -Path '${psStagingDir}\\\\*' -DestinationPath '${psZipPath}' -Force }`;
  run(`powershell -NoProfile -Command "${psCommand}"`);
  removeDirIfExists(stagingDir);
}

function publishRelease(version, assets) {
  const tag = `v${version}`;
  const title = `Node Manager ${tag}`;
  const notes = `Release automatica ${tag}`;
  const assetArgs = assets.map((asset) => `"${asset}"`).join(" ");

  console.log(`Publicando release en GitHub: ${tag}`);
  run(`gh release create ${tag} ${assetArgs} --title "${title}" --notes "${notes}"`);
  console.log("Release publicado en GitHub.");
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const currentVersion = packageJson.version;
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(`Version actual: ${currentVersion}`);
  console.log(`Nueva version: ${newVersion}`);

  updatePackageJson(newVersion);
  updateTauriConfig(newVersion);
  updateCargoToml(newVersion);

  console.log("Versiones actualizadas. Ejecutando build...");
  run("npm run tauri:build");

  ensureDir(releasesDir);
  const arch = getArchLabel();
  const releaseName = `node-manager-v${newVersion}-${arch}`;
  const zipPath = path.join(releasesDir, `${releaseName}.zip`);
  const portableZipPath = path.join(releasesDir, `${releaseName}-portable.zip`);
  const stagingDir = path.join(releasesDir, `.tmp-${releaseName}`);
  const portableStagingDir = path.join(releasesDir, `.tmp-${releaseName}-portable`);
  const bundleDir = path.join(rootDir, "src-tauri", "target", "release", "bundle");
  const portableExePath = path.join(rootDir, "src-tauri", "target", "release", "node-manager.exe");

  if (!fs.existsSync(bundleDir)) {
    throw new Error(`No existe el directorio de bundle: ${bundleDir}`);
  }

  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  if (fs.existsSync(portableZipPath)) {
    fs.unlinkSync(portableZipPath);
  }

  const artifacts = collectReleaseArtifacts(bundleDir, newVersion, arch);
  if (artifacts.length === 0) {
    throw new Error(`No se encontraron artefactos para version ${newVersion} y arquitectura ${arch}`);
  }

  buildZipFromArtifacts(artifacts, stagingDir, zipPath);
  if (!fs.existsSync(portableExePath)) {
    throw new Error(`No se encontro ejecutable portable: ${portableExePath}`);
  }
  buildZipFromArtifacts([portableExePath], portableStagingDir, portableZipPath);

  console.log(`Release generado: ${zipPath}`);
  console.log(`Portable generado: ${portableZipPath}`);

  if (shouldPublish) {
    publishRelease(newVersion, [zipPath, portableZipPath]);
  } else {
    console.log("Publicacion omitida. Usa --publish para subir a GitHub Release.");
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
