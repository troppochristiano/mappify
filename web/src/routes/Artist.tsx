import { useNavigate, useParams } from 'react-router-dom'
import { ArtistDetail } from '../components/ArtistDetail'

/**
 * Standalone artist page, kept only so /artist/:id stays deep-linkable. The
 * app itself opens artist info inside the globe's panel instead of navigating.
 */
export function Artist() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  return (
    <>
      <div className="controls">
        <button className="ghost" onClick={() => navigate(-1)}>← back</button>
      </div>
      <ArtistDetail id={id} />
    </>
  )
}
