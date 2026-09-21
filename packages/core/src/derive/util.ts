export function addUnique<T>(list: T[], values: Iterable<T>): void {
  for (const v of values) {
    if (!list.includes(v)) list.push(v);
  }
}
