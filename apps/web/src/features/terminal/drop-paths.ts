/** Window event the desktop app dispatches when files or folders are dropped on its window. */
export const DROP_PATHS_EVENT = 'orc:drop-paths';

export type DropPathsDetail = { paths: string[]; x: number; y: number };

/** Backslash-escapes a path the way macOS Terminal does when a file is dropped on it. */
export function shellEscapePath(path: string): string {
  return path.replace(/[^\w\-.,:/@+=%\u0080-￿]/g, '\\$&');
}

/** The text a terminal receives for a drop: escaped paths separated by spaces, plus a trailing space. */
export function dropText(paths: string[]): string {
  return paths.length === 0 ? '' : `${paths.map(shellEscapePath).join(' ')} `;
}
