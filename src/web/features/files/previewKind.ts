type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none'

const textLike = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml))/
const textExtensions = /\.(md|txt|json|ya?ml|xml|csv|log|ts|tsx|js|jsx|css|html|py|go|rs|sh|toml|ini|env)$/i

export function previewKind(mimeType: string, name: string): PreviewKind {
  // Google-native docs and drawings export as PDF via the raw endpoint.
  if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.drawing') return 'pdf'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'
  if (textLike.test(mimeType) || textExtensions.test(name)) return 'text'
  return 'none'
}

export function hasThumbnail(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType.startsWith('video/')
    || mimeType === 'application/pdf' || mimeType.startsWith('application/vnd.google-apps.')
}
