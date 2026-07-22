const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const packageJsonPath = path.join(projectRoot, 'package.json')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function printUsage() {
  console.log(`Usage:
  npm run release -- [version]
  npm run release:plan -- [version]
  npm run release:fast -- [version]

Builds all AgentDock release artifacts from one source tree:
  Windows x64: NSIS installer and blockmap
  Linux x64:   AppImage and DEB
  macOS arm64: unsigned ZIP containing AgentDock.app

Arguments:
  version        SemVer to write to package.json and package-lock.json.
                 Omit it to rebuild the version already in package.json.

Options:
  --skip-tests   Do not run npm test before packaging.
  --plan         Print the release plan without changing files or building.
  --dry-run      Alias for --plan when invoking this file directly with Node.
  -h, --help     Show this help.

The options are also available when invoking scripts/build-release.cjs directly.
On Windows, Linux and macOS packaging requires WSL with curl, tar, and xz.`)
}

function fail(message) {
  console.error(`Release failed: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
    ...options,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 'unknown'}`)
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with code ${result.status ?? 'unknown'}`)
  }
  return result.stdout.trim()
}

function quoteForBash(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function parseArguments(argv) {
  let version
  let dryRun = false
  let skipTests = false

  for (const argument of argv) {
    if (argument === '-h' || argument === '--help') return { help: true }
    if (argument === '--plan' || argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument === '--skip-tests') {
      skipTests = true
      continue
    }
    if (argument.startsWith('-')) fail(`unknown option ${argument}`)
    if (version) fail('only one version argument is allowed')
    version = argument.startsWith('v') ? argument.slice(1) : argument
  }

  if (version && !semverPattern.test(version)) fail(`invalid semantic version ${version}`)
  return { dryRun, help: false, skipTests, version }
}

function expectedArtifacts(version) {
  return [
    `AgentDock Setup ${version}.exe`,
    `AgentDock Setup ${version}.exe.blockmap`,
    `AgentDock-${version}.AppImage`,
    `agentdock_${version}_amd64.deb`,
    `AgentDock-${version}-mac-arm64-unsigned.zip`,
  ]
}

function replaceLeadingVersionFields(filePath, version, fieldCount) {
  const original = fs.readFileSync(filePath, 'utf8')
  let replacements = 0
  const updated = original.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/g, (match, prefix, suffix) => {
    if (replacements >= fieldCount) return match
    replacements += 1
    return `${prefix}${version}${suffix}`
  })

  if (replacements !== fieldCount) {
    throw new Error(`expected ${fieldCount} leading version field(s) in ${filePath}, found ${replacements}`)
  }
  JSON.parse(updated)
  if (updated !== original) fs.writeFileSync(filePath, updated)
}

function updateProjectVersion(version) {
  replaceLeadingVersionFields(packageJsonPath, version, 1)
  replaceLeadingVersionFields(path.join(projectRoot, 'package-lock.json'), version, 2)
}

function buildPosixArtifactsInWsl(version) {
  const windowsProjectRoot = projectRoot.replaceAll('\\', '/')
  const wslProjectRoot = capture('wsl.exe', ['--', 'wslpath', '-a', windowsProjectRoot])
  const safeVersion = version.replaceAll(/[^0-9A-Za-z.-]/g, '-')
  const nodeVersion = process.versions.node
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-release-'))
  const scriptPath = path.join(temporaryDirectory, 'build-posix.sh')
  const script = `#!/usr/bin/env bash
set -euo pipefail

project_root=${quoteForBash(wslProjectRoot)}
node_version=${quoteForBash(nodeVersion)}
release_version=${quoteForBash(version)}
mac_output="/tmp/agentdock-mac-$release_version-${process.pid}"

case "$(uname -m)" in
  x86_64) runtime_arch=x64 ;;
  aarch64|arm64) runtime_arch=arm64 ;;
  *) echo "Unsupported WSL architecture: $(uname -m)" >&2; exit 1 ;;
esac

node_root="/tmp/agentdock-node-v$node_version-$runtime_arch"
node_bin="$node_root/bin/node"
if [ ! -x "$node_bin" ]; then
  command -v curl >/dev/null || { echo "WSL curl is required" >&2; exit 1; }
  command -v tar >/dev/null || { echo "WSL tar is required" >&2; exit 1; }
  command -v xz >/dev/null || { echo "WSL xz is required" >&2; exit 1; }
  mkdir -p "$node_root"
  curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$runtime_arch.tar.xz" \
    | tar -xJ --strip-components=1 -C "$node_root"
fi

cd "$project_root"
"$node_bin" scripts/package.cjs --linux --x64 --publish never

cleanup() {
  rm -rf "$mac_output"
}
trap cleanup EXIT
rm -rf "$mac_output"
mkdir -p "$mac_output"

CSC_IDENTITY_AUTO_DISCOVERY=false "$node_bin" node_modules/electron-builder/out/cli/cli.js \
  "--config.directories.output=$mac_output" --mac --arm64 --dir --publish never

mac_app="$mac_output/mac-arm64/AgentDock.app"
test -d "$mac_app" || { echo "macOS app was not created at $mac_app" >&2; exit 1; }

seven_zip="$project_root/node_modules/7zip-bin/linux/$runtime_arch/7za"
test -x "$seven_zip" || { echo "7za was not found at $seven_zip" >&2; exit 1; }

archive_name="AgentDock-${safeVersion}-mac-arm64-unsigned.zip"
archive_temp="$mac_output/$archive_name"
(
  cd "$mac_output/mac-arm64"
  "$seven_zip" a -tzip -mx=9 -snl "$archive_temp" AgentDock.app
)
cp -f "$archive_temp" "$project_root/release/AgentDock-$release_version-mac-arm64-unsigned.zip"
`

  fs.writeFileSync(scriptPath, script)
  try {
    const windowsScriptPath = scriptPath.replaceAll('\\', '/')
    const wslScriptPath = capture('wsl.exe', ['--', 'wslpath', '-a', windowsScriptPath])
    run('wsl.exe', ['--', 'bash', wslScriptPath])
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}

function verifyArtifacts(version) {
  const releaseDir = path.join(projectRoot, 'release')
  const artifacts = expectedArtifacts(version).map((name) => {
    const artifactPath = path.join(releaseDir, name)
    if (!fs.existsSync(artifactPath)) throw new Error(`expected artifact is missing: ${artifactPath}`)
    const size = fs.statSync(artifactPath).size
    if (size === 0) throw new Error(`expected artifact is empty: ${artifactPath}`)
    return { name, size }
  })

  console.log(`\nRelease ${version} is ready in ${releaseDir}:`)
  for (const artifact of artifacts) {
    console.log(`  ${artifact.name} (${(artifact.size / 1024 / 1024).toFixed(2)} MiB)`)
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const currentPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const version = options.version || currentPackage.version
  if (!semverPattern.test(version)) fail(`package.json contains invalid semantic version ${version}`)

  console.log(`AgentDock release plan for ${version}`)
  for (const artifact of expectedArtifacts(version)) console.log(`  release/${artifact}`)
  if (options.dryRun) {
    console.log('\nDry run complete; no files were changed.')
    return
  }

  if (process.platform !== 'win32') {
    fail('the all-platform release script currently requires Windows with WSL')
  }

  try {
    if (options.version) {
      updateProjectVersion(version)
      console.log(`Updated package.json and package-lock.json to ${version}.`)
    }
    if (!options.skipTests) run(npmCommand, ['test'])
    run(npmCommand, ['run', 'build'])
    run(process.execPath, ['scripts/package.cjs', '--win', '--x64', '--publish', 'never'])
    buildPosixArtifactsInWsl(version)
    verifyArtifacts(version)
  } catch (error) {
    fail(error.message)
  }
}

main()
