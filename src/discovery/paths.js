/**
 * Recorded paths, read on the machine backpass runs on.
 *
 * A harness records paths in the spelling of the system it ran on. On a POSIX host a
 * Windows drive path (`C:\work\repo`, `C:/work/repo`) or a UNC path (`\\server\share`,
 * or `//server/share` as Windows tools write it with forward slashes) is not absolute,
 * so `path.resolve` quietly turns it into a location under the process cwd - which is
 * inside the very repository backpass was started from. That made every such session a
 * tier-1 match for whichever repo ran the scan (issue #164).
 *
 * Every reader that resolves a recorded path - association, user-scope project keys, and
 * nested-file attribution - goes through `localPath` first, so a path that names no place
 * on this machine is refused once, here, instead of being resolved against the wrong
 * base. On Windows the recorded spelling is already local.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const WINDOWS_UNC = /^(?:\\\\[^\\/]|\/\/[^\\/])/;

/** True for a Windows drive or UNC path, whatever system reads it. */
export function isWindowsPath(recorded) {
  return typeof recorded === "string" && (WINDOWS_DRIVE.test(recorded) || WINDOWS_UNC.test(recorded));
}

/**
 * The recorded path as this machine spells it, or null when it names no place here.
 *
 * @param {unknown} recorded
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {string | null}
 */
export function localPath(recorded, { platform = process.platform } = {}) {
  if (typeof recorded !== "string" || !recorded) return null;
  if (platform === "win32") return recorded;
  return isWindowsPath(recorded) ? null : recorded;
}
