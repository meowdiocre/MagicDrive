import { PasswordUnlockDialog } from '@/components/AccessControls'

interface UnlockStorageDialogProps {
  open: boolean
  name: string
  onUnlock: (password: string) => Promise<void>
  onClose: () => void
}

export function UnlockStorageDialog({ open, name, onUnlock, onClose }: UnlockStorageDialogProps) {
  return (
    <PasswordUnlockDialog
      open={open}
      name={name}
      subject="storage"
      onUnlock={onUnlock}
      onClose={onClose}
    />
  )
}
