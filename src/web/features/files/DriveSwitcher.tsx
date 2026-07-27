import { EyeOff, Layers, LockKeyhole, WandSparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Select, SelectItem } from '@/components/ui'
import type { DriveInfo } from '@/types'

interface DriveSwitcherProps {
  drives: DriveInfo[]
  activeDriveId: string
  onSwitch: (driveId: string) => void
  className?: string
}

function hint(drive: DriveInfo) {
  if (drive.provider === 'vault') return <Badge tone="accent"><WandSparkles /> managed</Badge>
  if (drive.is_virtual) return <Badge tone="accent"><Layers /> pooled</Badge>
  if (drive.access_mode === 'private') return <Badge tone="neutral"><EyeOff /> private</Badge>
  if (drive.access_mode === 'protected') return <Badge tone="warning"><LockKeyhole /> {drive.locked ? 'locked' : 'protected'}</Badge>
  return drive.is_owner ? undefined : <Badge tone="neutral">read-only</Badge>
}

export function DriveSwitcher({ drives, activeDriveId, onSwitch, className }: DriveSwitcherProps) {
  return (
    <Select value={activeDriveId} onValueChange={onSwitch} label="Active storage" className={cn(className)}>
      {drives.map(drive => (
        <SelectItem key={drive.id} value={drive.id} hint={hint(drive)}>
          {drive.name}
        </SelectItem>
      ))}
    </Select>
  )
}
