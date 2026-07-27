import { LayoutGrid, List } from 'lucide-react'
import { ToggleGroup } from '@/components/ui'
import type { Layout } from '@/types'

export function LayoutToggle({ layout, onChange }: { layout: Layout; onChange: (value: Layout) => void }) {
  return (
    <ToggleGroup<Layout>
      value={layout}
      onValueChange={onChange}
      label="File layout"
      options={[
        { value: 'list', label: 'List view', icon: <List /> },
        { value: 'grid', label: 'Grid view', icon: <LayoutGrid /> },
      ]}
    />
  )
}
