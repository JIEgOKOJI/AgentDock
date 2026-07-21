const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const releaseDir = path.join(projectRoot, 'release')
const localBuildRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'AgentDock', 'builder')
  : path.join(os.tmpdir(), 'AgentDock', 'builder')
const buildDir = path.join(localBuildRoot, `${Date.now()}-${process.pid}`)
const builderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const builderArgs = process.argv.slice(2)

fs.mkdirSync(buildDir, { recursive: true })
fs.mkdirSync(releaseDir, { recursive: true })

console.log(`Packaging outside the protected workspace: ${buildDir}`)

const result = spawnSync(process.execPath, [
  builderCli,
  `--config.directories.output=${buildDir}`,
  ...builderArgs,
], {
  cwd: projectRoot,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const requestedPlatform = builderArgs.includes('--win') ? 'win32'
  : builderArgs.includes('--mac') ? 'darwin'
    : builderArgs.includes('--linux') ? 'linux'
      : process.platform
const deliverableExtensions = new Set(['.blockmap', '.yml', '.yaml'])
let installerExtensions
let installerLabel
if (requestedPlatform === 'win32') {
  deliverableExtensions.add('.exe')
  installerExtensions = new Set(['.exe'])
  installerLabel = 'Windows installer'
} else if (requestedPlatform === 'darwin') {
  deliverableExtensions.add('.dmg')
  installerExtensions = new Set(['.dmg'])
  installerLabel = 'macOS disk image'
} else {
  deliverableExtensions.add('.appimage')
  deliverableExtensions.add('.deb')
  deliverableExtensions.add('.rpm')
  deliverableExtensions.add('.snap')
  installerExtensions = new Set(['.appimage', '.deb', '.rpm', '.snap'])
  installerLabel = 'Linux package'
}
const deliverables = fs.readdirSync(buildDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && deliverableExtensions.has(path.extname(entry.name).toLowerCase()))

if (!deliverables.some((entry) => installerExtensions.has(path.extname(entry.name).toLowerCase()))) {
  throw new Error(`electron-builder completed but produced no ${installerLabel} in ${buildDir}`)
}

for (const entry of deliverables) {
  const source = path.join(buildDir, entry.name)
  const destination = path.join(releaseDir, entry.name)
  fs.copyFileSync(source, destination)
  console.log(`Created ${destination}`)
}

try {
  fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 })
} catch (error) {
  console.warn(`Installer is ready; temporary unpacked files remain at ${buildDir}: ${error.message}`)
}
