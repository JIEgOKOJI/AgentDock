const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const electronDir = path.resolve(__dirname, '..', 'electron')
const files = fs.readdirSync(electronDir)
  .filter((name) => name.endsWith('.cjs'))
  .sort()

for (const name of files) {
  const filePath = path.join(electronDir, name)
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${filePath}\n`)
    process.exit(result.status || 1)
  }
}

console.log(`Electron syntax check passed (${files.length} files).`)
