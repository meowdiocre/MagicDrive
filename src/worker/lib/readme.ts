import { providerFileResponse } from './file-response'
import type { FileItem } from '../types'

export const README_NAME = 'README.md'
export const CAULDRON_README_ID = 'magicdrive-readme-cauldron'
export const VAULT_README_ID = 'magicdrive-readme-vault'

export const CAULDRON_README = `# The Cauldron

The Cauldron combines storage contributed by MagicDrive members into one shared workspace.

## How it works

- Everyone can browse pooled folders and download shared files.
- Magicians create folders and manage files inside the pool.
- Uploads use available capacity across contributor storage.

## Privacy

Only pool-managed folders appear here. Contributing a drive does not expose its private folders or files.
`

export const VAULT_README = `# MagicVault

MagicVault encrypts each file, splits it into pieces, and stores those pieces across the file owner's connected storage.

## What to expect

- Uploads are encrypted before placement.
- Files can span multiple connected providers.
- Only the owner can rename or delete their files.
- Provider capacity includes data outside MagicDrive.

## Storage safety

Disconnect a provider only after removing MagicVault files that use it.
`

export function systemReadmeItem(id: string, content: string): FileItem {
  return {
    id,
    name: README_NAME,
    mimeType: 'text/markdown',
    size: new TextEncoder().encode(content).byteLength,
    modifiedTime: null,
    createdTime: null,
    thumbnailLink: null,
    isFolder: false,
    readOnly: true,
    system: true,
  }
}

export function systemReadmeResponse(
  content: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): Response {
  const size = new TextEncoder().encode(content).byteLength
  return providerFileResponse(new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(size),
    },
  }), README_NAME, disposition)
}
