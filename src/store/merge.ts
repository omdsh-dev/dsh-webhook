/** Three-way merge for one independently mutable record collection. */
export function mergeRecords<T extends { id: string }>(
  ours: readonly T[],
  base: ReadonlyMap<string, string>,
  latest: ReadonlyMap<string, T>,
  deleted: ReadonlySet<string>,
): T[] {
  const merged: T[] = []
  const seen = new Set<string>()
  const byId = new Map(ours.map(record => [record.id, record]))
  for (const [id, current] of latest) {
    if (deleted.has(id)) continue
    seen.add(id)
    const our = byId.get(id)
    if (our === undefined) merged.push(current)
    else if (JSON.stringify(our) === base.get(id)) merged.push(current)
    else merged.push(our)
  }
  for (const record of ours) {
    if (seen.has(record.id) || deleted.has(record.id)) continue
    if (JSON.stringify(record) === base.get(record.id)) continue
    merged.push(record)
  }
  return merged
}
