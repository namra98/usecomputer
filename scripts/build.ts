// Cross-target builder for usecomputer native Zig artifacts.

import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Target = {
  name: string
  zigTarget: string
  cpu?: string
}

const rootDirectory = path.resolve(import.meta.dirname, '..')
const distDirectory = path.join(rootDirectory, 'dist')
const zigOutputDirectory = path.join(rootDirectory, 'zig-out', 'lib')

// Read version from package.json so the Zig binary embeds the correct version string
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf-8'))
const packageVersion: string = packageJson.version

// host platform in the same format as target names (e.g. "linux-x64", "darwin-arm64")
const hostTarget = `${os.platform()}-${os.arch()}`

const targets: Target[] = [
  { name: 'darwin-arm64', zigTarget: 'aarch64-macos' },
  { name: 'darwin-x64', zigTarget: 'x86_64-macos' },
  { name: 'linux-arm64', zigTarget: 'aarch64-linux-gnu' },
  { name: 'linux-x64', zigTarget: 'x86_64-linux-gnu' },
  { name: 'win32-x64', zigTarget: 'x86_64-windows', cpu: 'baseline' },
]

// Zig 0.15.2's linker can't parse macOS 26+ SDK TBD files (arm64e-macos
// targets, no arm64-macos). Using the CommandLineTools SDK (which still has
// arm64-macos) via DEVELOPER_DIR works around this without needing sudo.
function zigEnv(): Record<string, string> {
  const env = { ...process.env }
  if (
    process.platform === 'darwin' &&
    !process.env['DEVELOPER_DIR'] &&
    fs.existsSync('/Library/Developer/CommandLineTools')
  ) {
    env['DEVELOPER_DIR'] = '/Library/Developer/CommandLineTools'
  }
  return env
}

function runCommand({ command, args, cwd }: { command: string; args: string[]; cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: command === 'zig' ? zigEnv() : undefined,
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed with code ${String(code)}`))
    })
  })
}

const zigBinDirectory = path.join(rootDirectory, 'zig-out', 'bin')

function resolveNativeBinaryPath(): Error | string {
  const candidates = ['usecomputer.node', 'usecomputer.dll', 'libusecomputer.so'].map((fileName) => {
    return path.join(zigOutputDirectory, fileName)
  })
  const found = candidates.find((candidate) => {
    return fs.existsSync(candidate)
  })
  if (!found) {
    return new Error(`No native artifact found in ${zigOutputDirectory}`)
  }
  return found
}

function resolveStandaloneExePath(): string | undefined {
  const candidates = ['usecomputer', 'usecomputer.exe'].map((fileName) => {
    return path.join(zigBinDirectory, fileName)
  })
  return candidates.find((candidate) => {
    return fs.existsSync(candidate)
  })
}

async function buildTarget({ target }: { target: Target }): Promise<void> {
  fs.rmSync(path.join(rootDirectory, 'zig-out'), { recursive: true, force: true })
  // When building for the host platform, omit -Dtarget so Zig uses the
  // native system include/lib paths. Cross-compiling with an explicit
  // target makes Zig ignore host system libraries (X11, png, etc).
  const isNativeBuild = target.name === hostTarget && !target.cpu
  const zigArgs = isNativeBuild
    ? ['build', '-Doptimize=ReleaseFast', `-Dversion=${packageVersion}`]
    : ['build', '-Doptimize=ReleaseFast', `-Dtarget=${target.zigTarget}`, `-Dversion=${packageVersion}`]
  if (target.cpu) {
    zigArgs.push(`-Dcpu=${target.cpu}`)
  }
  await runCommand({
    command: 'zig',
    args: zigArgs,
    cwd: rootDirectory,
  })
  const source = resolveNativeBinaryPath()
  if (source instanceof Error) {
    throw source
  }
  const targetDirectory = path.join(distDirectory, target.name)
  fs.mkdirSync(targetDirectory, { recursive: true })
  fs.copyFileSync(source, path.join(targetDirectory, 'usecomputer.node'))

  // Also copy the standalone executable if it was built
  const exePath = resolveStandaloneExePath()
  if (exePath) {
    const exeFileName = target.name.startsWith('win32') ? 'usecomputer.exe' : 'usecomputer'
    const destExePath = path.join(targetDirectory, exeFileName)
    fs.copyFileSync(exePath, destExePath)
    // Ensure executable permission on unix
    if (!target.name.startsWith('win32')) {
      fs.chmodSync(destExePath, 0o755)
    }
  }
}

async function main(): Promise<void> {
  const requestedTargets = process.argv.slice(2)
  const selectedTargets = requestedTargets.length
    ? targets.filter((target) => {
        return requestedTargets.includes(target.name)
      })
    : targets

  if (selectedTargets.length === 0) {
    throw new Error(`No matching target. Available: ${targets.map((target) => target.name).join(', ')}`)
  }

  for (const target of selectedTargets) {
    await buildTarget({ target })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
