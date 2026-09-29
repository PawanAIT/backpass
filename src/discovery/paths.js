import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Recorded paths, read on the machine backpass runs on.
 *
 * A harness records paths in the spelling of the system it ran on. On POSIX, drive
 * paths (`C:\work\repo`, `C:/work/repo`) and backslash UNC paths (`\\server\share`)
 * resolve under the process cwd, risking false association with the current repo.
 * Forward-slash UNC paths (`//server/share`) are absolute on POSIX but resolve as local
 * paths rather than Windows network shares, so they must also be refused.
 *
 * Every reader that resolves a recorded path - association, user-scope project keys, and
 * nested-file attribution - goes through `localPath` first, so a path that names no place
 * on this machine is refused once, here, instead of being resolved against the wrong
 * base. On Windows the recorded spelling is already local.
 *
 * Under WSL the same Windows paths do name places here, and are read the way WSL itself
 * mounts them: a drive path lives wherever `/proc/mounts` mounts that drive (`/mnt/c` by
 * default), and `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...` is this distro's
 * own filesystem when `<distro>` is the one backpass runs in (`WSL_DISTRO_NAME`). A drive
 * that is not mounted, another distro, or a network share still names nothing here.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const WINDOWS_UNC = /^(?:\\\\[^\\/]|\/\/[^\\/])/;
const DRIVE_PATH = /^([A-Za-z]):(?:[\\/]+(.*))?$/s;
const UNC_PATH = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/s;
const WSL_HOSTS = /^(?:wsl\.localhost|wsl\$)$/i;
const DRIVE_SOURCE = /^([A-Za-z]):\\?$/;

/** True for a Windows drive or UNC path, whatever system reads it. */
export function isWindowsPath(recorded) {
  return typeof recorded === "string" && (WINDOWS_DRIVE.test(recorded) || WINDOWS_UNC.test(recorded));
}

/**
 * @typedef {{ distro: string | null, drives: Map<string, string> }} WslEnvironment
 */

/**
 * The recorded path as this machine spells it, or null when it names no place here.
 *
 * @param {unknown} recorded
 * @param {{ platform?: NodeJS.Platform, wsl?: WslEnvironment | null }} [options]
 *   `wsl` defaults to the environment backpass runs in (`wslEnvironment`).
 * @returns {string | null}
 */
export function localPath(recorded, { platform = process.platform, wsl } = {}) {
  if (typeof recorded !== "string" || !recorded) return null;
  if (platform === "win32" || !isWindowsPath(recorded)) return recorded;
  const environment = wsl === undefined ? wslEnvironment({ platform }) : wsl;
  return environment ? fromWindows(recorded, environment) : null;
}

function fromWindows(recorded, { distro, drives }) {
  const segments = (rest) => (rest || "").split(/[\\/]+/).filter(Boolean);
  const drive = recorded.match(DRIVE_PATH);
  if (drive) {
    const mount = drives.get(drive[1].toLowerCase());
    return mount ? path.posix.join(mount, path.posix.resolve("/", ...segments(drive[2])).slice(1)) : null;
  }
  const unc = recorded.match(UNC_PATH);
  if (unc && WSL_HOSTS.test(unc[1]) && distro && unc[2].toLowerCase() === distro.toLowerCase()) {
    return path.posix.join("/", ...segments(unc[3]));
  }
  return null;
}

/** `/proc/mounts` escapes a space, tab, newline or backslash in a field as octal. */
function unescapeMountField(field) {
  return field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Windows drives and where WSL mounted them, from `/proc/self/mountinfo` text: drvfs names each
 * mount by its drive (`C:\` under WSL 2, `C:` under WSL 1).
 *
 * @param {string} text
 * @returns {Map<string, string>} lower-case drive letter -> mount point
 */
export function parseDriveMounts(text) {
  const drives = new Map();
  for (const line of String(text || "").split("\n")) {
    const [mount, filesystem] = line.split(" - ");
    if (!filesystem) continue;
    const [, , , root, target] = mount.split(" ");
    const [, source] = filesystem.split(" ");
    if (root !== "/" || !source || !target) continue;
    const match = unescapeMountField(source).match(DRIVE_SOURCE);
    const letter = match?.[1].toLowerCase();
    if (letter && !drives.has(letter)) drives.set(letter, unescapeMountField(target));
  }
  return drives;
}

let driveTable = null;
let wslKernel = null;

/**
 * The WSL environment backpass runs in, or null when it is not WSL. The distro comes
 * from `WSL_DISTRO_NAME`, which WSL sets for every process it starts; the mount table
 * is read once.
 *
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [options]
 * @returns {WslEnvironment | null}
 */
export function wslEnvironment({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "linux") return null;
  const distro = env.WSL_DISTRO_NAME || null;
  if (wslKernel === null) wslKernel = /microsoft/i.test(os.release());
  if (!distro && !wslKernel) return null;
  if (driveTable === null) {
    try {
      driveTable = parseDriveMounts(fs.readFileSync("/proc/self/mountinfo", "utf8"));
    } catch {
      driveTable = new Map();
    }
  }
  return { distro, drives: driveTable };
}
