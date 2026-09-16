/** Joins two ids into a single map/set key. */
export function pairKey({ a, b }: { a: string; b: string }): string {
  return `${a}|${b}`;
}

/** Inverse of pairKey. Throws if the key is malformed. */
export function splitKey(key: string): [string, string] {
  const [a, b] = key.split('|');
  if (!a || !b) throw new Error(`Malformed pair key: ${key}`);
  return [a, b];
}
