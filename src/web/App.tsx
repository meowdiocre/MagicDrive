import { Toaster } from 'sonner'
import { useSession } from '@/features/auth/useSession'
import { Workspace } from '@/layout/Workspace'
import { Brand } from '@/components/Brand'
import { TooltipProvider } from '@/components/ui'
import { useTheme } from '@/hooks/useTheme'

export default function App() {
  const { session, booting, logout, refresh } = useSession()
  const theme = useTheme()

  return (
    <TooltipProvider>
      {booting ? (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-3 font-vault-mono text-sm text-vault-muted">
          <Brand />
          <span>Loading MagicDrive</span>
        </div>
      ) : (
        <Workspace
          session={session}
          onLogout={() => void logout()}
          onSignedIn={() => void refresh()}
          theme={theme}
        />
      )}

      <Toaster
        theme={theme.resolved}
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: 'font-vault-body rounded-vault-sm border border-vault-rule bg-vault-surface text-vault-ink',
            description: 'text-vault-muted',
          },
        }}
      />
    </TooltipProvider>
  )
}
