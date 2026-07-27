import { Avatar as A } from 'radix-ui'

export function Avatar({ name, src }: { name: string; src?: string }) {
  return (
    <A.Root aria-hidden="true" className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-vault-accent text-vault-accent-ink">
      {src && <A.Image src={src} alt="" className="size-full object-cover" />}
      <A.Fallback className="text-sm font-bold">
        {name.slice(0, 1).toUpperCase()}
      </A.Fallback>
    </A.Root>
  )
}
