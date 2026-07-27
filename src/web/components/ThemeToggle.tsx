import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemePreference } from '@/hooks/useTheme'
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuTrigger, Tooltip,
} from './ui'

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

export function ThemeToggle({ preference, resolved, onChange }: {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  onChange: (value: ThemePreference) => void
}) {
  const Current = preference === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun

  return (
    <DropdownMenu>
      <Tooltip label="Theme">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${preference}`}>
            <Current />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent>
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        {OPTIONS.map(option => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
            <option.icon />
            {option.label}
            {preference === option.value && <span className="ml-auto text-vault-accent">•</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
