import { FolderOpen, HardDrive, Share2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { View } from '@/types'

// `private` views list per-user records, so they are hidden from anonymous visitors.
export const NAV_ITEMS: { view: View; label: string; icon: LucideIcon; private?: boolean }[] = [
  { view: 'files', label: 'Files', icon: FolderOpen },
  { view: 'storage', label: 'Storage', icon: HardDrive },
  { view: 'shares', label: 'Shares', icon: Share2, private: true },
]
