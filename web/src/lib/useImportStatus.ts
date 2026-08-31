import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type SetupInfo } from './api'

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

/**
 * The first import, started without anyone asking for it.
 *
 * A library is the entire point of the app, and on a fresh install there is
 * exactly one useful thing to do — so making someone open the options tab to
 * find a button with no alternative is a step that exists only because it was
 * easier to write. Signing in is the consent; this is what they signed in for.
 *
 * Only ever the first. `phase` is `'idle'` solely before any import has run in
 * this process, so a finished one cannot retrigger this — which matters most
 * for the account that finishes with nothing on the map, where `hasLibrary`
 * stays false and a laxer condition would import forever.
 *
 * The ref guards the gap between firing and the status reflecting it: two
 * renders can see the same idle status before the request answers. It is never
 * cleared, including on failure — a retry loop against a Spotify that is
 * refusing is worse than the button the panel still has.
 */
export function useAutoImport(setup: SetupInfo | undefined) {
  const qc = useQueryClient()
  const status = useImportStatus()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    if (!setup?.signedIn || !setup.spotify.connected || setup.hasLibrary) return
    const job = status.data
    if (!job || job.running || job.phase !== 'idle') return

    started.current = true
    api
      .startImport()
      .catch(() => {})
      .finally(() => qc.invalidateQueries({ queryKey: ['import-status'] }))
  }, [setup, status.data, qc])
}
