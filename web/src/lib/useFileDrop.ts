import { useEffect, useState } from 'react'

/** The extension a shared library arrives as. */
export const SHARE_EXT = '.mappify'

/**
 * Whether a drag is carrying files, as opposed to selected text or a link.
 *
 * Read from `types` rather than `files`, which is empty during a drag for
 * privacy reasons and only fills in on the drop itself.
 */
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * A `.mappify` file dropped anywhere on the window.
 *
 * The panel's file picker still exists and does exactly the same thing. This is
 * the gesture people try first — and without it the browser's own default wins,
 * which is to leave the app and render the file as a download. Somebody who
 * dragged their friend's library onto the globe would watch Mappify vanish.
 *
 * `dragover` must be cancelled on every event rather than once: a drop is only
 * permitted on an element that refused the drag immediately before it.
 *
 * The counter exists because dragging across a child element fires leave before
 * enter, so a boolean flickers the overlay off every time the pointer crosses a
 * panel edge.
 */
export function useFileDrop(onFile: (file: File) => void, onWrongFile: (name: string) => void) {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let depth = 0

    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Before anything else, and whatever was dropped: the alternative to
      // handling a wrong file is the browser navigating away from the app.
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      const share = files.find((f) => f.name.toLowerCase().endsWith(SHARE_EXT))
      if (share) onFile(share)
      else if (files.length) onWrongFile(files[0].name)
    }

    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [onFile, onWrongFile])

  return dragging
}
