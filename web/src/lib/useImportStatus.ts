import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

/**
 * The import's progress, and refreshing the globe as it makes some.
 *
 * This used to live inside SetupPanel, which is only mounted while the library
 * panel is open — so closing the panel mid-import meant the map never updated
 * again until a manual reload. It belongs somewhere always mounted.
 *
 * Refreshing is keyed on the server's `revision`, which ticks once per real
 * change to what the map draws. That is what makes this both progressive and
 * loop-free: waiting for `phase === 'done'` meant staring at an empty globe for
 * twenty minutes, and invalidating on every poll would refetch four times a
 * second forever.
 *
 * SetupPanel calls this too, for its progress bar. react-query dedupes on the
 * shared key, so there is still exactly one poll either way.
 */
export function useImportStatus() {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['import-status'],
    queryFn: api.importStatus,
    refetchInterval: (q) => (q.state.data?.running ? 1000 : false),
  })

  const revision = status.data?.revision ?? 0
  useEffect(() => {
    if (!revision) return
    // Prefix matches, so ['map', filterKey] for every filter refreshes too.
    for (const key of [['map'], ['tree'], ['links'], ['stats'], ['sources']]) {
      qc.invalidateQueries({ queryKey: key })
    }
  }, [revision, qc])

  return status
}
