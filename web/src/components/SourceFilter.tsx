import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * Narrow the whole map to one part of the library.
 *
 * Only sources whose tracks are actually in the database are offered. Spotify
 * stopped serving playlist items for playlists you neither own nor collaborate
 * on, so those rows exist with a name and a total but no contents — offering
 * them would give you a picker entry that silently empties the globe. They are
 * left out rather than shown greyed, since there is nothing you could do about
 * one anyway.
 *
 * Grouped by kind rather than listed flat: a library runs to hundreds of saved
 * albums, and "Liked Songs" has to stay findable among them.
 */
export function SourceFilter({
  value,
  onChange,
}: {
  value: string | null
  onChange: (id: string | null) => void
}) {
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources })
  const usable = (sources.data?.sources ?? []).filter((s) => s.imported > 0)

  const group = (kind: string) =>
    usable.filter((s) => s.kind === kind).sort((a, b) => b.imported - a.imported)

  const liked = group('liked')
  const playlists = group('playlist')
  const albums = group('album')

  return (
    <select
      className="source-filter"
      aria-label="Filter by part of the library"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">whole library</option>
      {liked.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} ({s.imported})
        </option>
      ))}
      {playlists.length > 0 && (
        <optgroup label="Playlists">
          {playlists.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.imported})
            </option>
          ))}
        </optgroup>
      )}
      {albums.length > 0 && (
        <optgroup label="Saved albums">
          {albums.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.imported})
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
