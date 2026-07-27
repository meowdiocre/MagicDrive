import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { Sheet } from '@/components/ui'
import { SEARCH_PATH, useFiles } from '@/features/files/useFiles'
import { FilesView } from '@/features/files/FilesView'
import { useDrives } from '@/features/storage/useDrives'
import { StorageView } from '@/features/storage/StorageView'
import { useShares } from '@/features/shares/useShares'
import { SharesView } from '@/features/shares/SharesView'
import { Sidebar, SidebarNav } from './Sidebar'
import { TopBar } from './TopBar'
import type { ThemeState } from '@/hooks/useTheme'
import type { Layout, Session, View } from '@/types'

interface WorkspaceProps {
  session: Session | null
  onLogout: () => void
  onSignedIn: () => void
  theme: ThemeState
}

export function Workspace({ session, onLogout, onSignedIn, theme }: WorkspaceProps) {
  const [view, setView] = useState<View>('files')
  const [layout, setLayout] = useLocalStorage<Layout>('vd_layout', 'list', ['list', 'grid'])
  const [query, setQuery] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const drives = useDrives(session?.userId)
  const files = useFiles(drives.activeDriveId)
  const shares = useShares(session?.userId)
  const activeDriveLocked = Boolean(drives.items.find(drive => drive.id === drives.activeDriveId)?.locked)

  useEffect(() => {
    if (view !== 'files' || files.path === SEARCH_PATH || activeDriveLocked) return
    setQuery('')
    void files.loadFiles(files.path)
  }, [activeDriveLocked, files.path, view, files.loadFiles])

  async function runSearch(event: FormEvent) {
    event.preventDefault()
    if (query.trim().length < 2) return
    setView('files')
    await files.search(query)
  }

  function switchView(value: View) {
    setView(value)
    setMobileNav(false)
  }

  const navProps = { session, view, onSwitchView: switchView, onLogout, onSignedIn, theme }

  return (
    <div className="grid min-h-dvh grid-cols-[15rem_minmax(0,1fr)] max-[60rem]:grid-cols-1">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-60 focus:rounded-vault-sm focus:bg-vault-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-vault-paper"
      >
        Skip to content
      </a>

      <Sidebar {...navProps} />

      <Sheet open={mobileNav} onOpenChange={setMobileNav} title="Navigation" returnFocusTo={menuButtonRef}>
        <SidebarNav {...navProps} />
      </Sheet>

      <main id="main-content" tabIndex={-1} className="flex min-h-dvh min-w-0 flex-col outline-none">
        <TopBar
          onOpenNav={() => setMobileNav(true)}
          menuButtonRef={menuButtonRef}
          value={query}
          onChange={setQuery}
          onSubmit={event => void runSearch(event)}
          onClear={() => { setQuery(''); if (files.isSearchView) files.clearSearch() }}
          searching={files.searching}
          invalid={files.isSearchView && Boolean(files.error)}
        />

        <div className="w-full max-w-336 flex-1 px-6 py-6 max-[60rem]:px-4">
          {view === 'files' && (
            <FilesView
              files={files}
              shares={shares}
              drives={drives}
              layout={layout}
              canShare={Boolean(session)}
              onChangeLayout={setLayout}
              onConnect={() => setView('storage')}
            />
          )}
          {view === 'storage' && <StorageView session={session} drives={drives} onSignedIn={onSignedIn} />}
          {view === 'shares' && session && <SharesView shares={shares} />}
        </div>
      </main>
    </div>
  )
}
