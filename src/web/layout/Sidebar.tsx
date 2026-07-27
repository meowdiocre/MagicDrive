import { LogOut } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar, Button } from '@/components/ui'
import { Brand } from '@/components/Brand'
import { SignInButton } from '@/components/SignInButton'
import { ThemeToggle } from '@/components/ThemeToggle'
import { NAV_ITEMS } from './nav'
import type { ThemeState } from '@/hooks/useTheme'
import type { Session, View } from '@/types'

interface SidebarNavProps {
  session: Session | null
  view: View
  onSwitchView: (view: View) => void
  onLogout: () => void
  onSignedIn: () => void
  theme: ThemeState
}

export function SidebarNav({ session, view, onSwitchView, onLogout, onSignedIn, theme }: SidebarNavProps) {
  const items = NAV_ITEMS.filter(item => session || !item.private)

  return (
    <>
      <Brand />

      <nav className="mt-8 grid gap-0.5" aria-label="Primary">
        {items.map(item => {
          const active = view === item.view
          return (
            <button
              key={item.view}
              onClick={() => onSwitchView(item.view)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-vault-sm px-3 text-left text-sm text-vault-muted outline-offset-1 transition-colors duration-(--dur-fast) hover:bg-vault-paper-3 hover:text-vault-ink',
                active && 'bg-vault-accent-soft font-semibold text-vault-accent ring-1 ring-vault-accent/35 hover:bg-vault-accent-soft hover:text-vault-accent',
              )}
            >
              <item.icon className="size-4.5 shrink-0" />
              {item.label}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto grid gap-3 border-t border-vault-rule pt-4">
        {session ? (
          <>
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar name={session.username} />
              <span className="grid min-w-0 flex-1">
                <strong className="truncate text-sm font-medium">{session.username}</strong>
                <small className="truncate font-vault-mono text-xs text-vault-subtle">
                  {session.role === 'magician' ? 'magician' : 'signed in'}
                </small>
              </span>
              <ThemeToggle preference={theme.preference} resolved={theme.resolved} onChange={theme.setTheme} />
            </div>
            <Button variant="ghost" size="sm" onClick={onLogout} className="w-fit px-2 hover:text-vault-danger">
              <LogOut /> Sign out
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="font-vault-mono text-xs text-vault-subtle">Browsing as a guest</p>
              <ThemeToggle preference={theme.preference} resolved={theme.resolved} onChange={theme.setTheme} />
            </div>
            <SignInButton variant="secondary" size="sm" onSignedIn={onSignedIn} />
          </>
        )}
      </div>
    </>
  )
}

export function Sidebar(props: SidebarNavProps) {
  return (
    <aside className="sticky top-0 flex h-dvh min-h-0 w-full flex-col self-start overflow-y-auto border-r border-vault-rule bg-vault-paper-2 px-4 py-5 max-[60rem]:hidden">
      <SidebarNav {...props} />
    </aside>
  )
}
