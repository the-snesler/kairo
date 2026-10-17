import { useEffect, useState } from 'react'

// The server renders /api/icon/today (server clock); once hydrated, the browser
// switches to its own local date and rolls over at midnight.
export function LiveFavicon() {
  const [day, setDay] = useState<number | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      const now = new Date()
      setDay(now.getDate())
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      clearTimeout(timer)
      timer = setTimeout(update, midnight.getTime() - now.getTime() + 1000)
    }
    update()
    // Timers stall while a laptop sleeps; re-check when the tab comes back.
    document.addEventListener('visibilitychange', update)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  return <link rel="icon" type="image/svg+xml" href={`/api/icon/${day ?? 'today'}`} />
}
