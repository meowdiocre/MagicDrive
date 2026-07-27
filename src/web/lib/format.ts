export function formatBytes(value: number | null, fractionDigits?: number, unknownLabel = '-') {
  if (value === null || !Number.isFinite(value)) return unknownLabel
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(fractionDigits ?? (index ? 1 : 0))} ${units[index]}`
}

export function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

const kindLabels: [RegExp, string][] = [
  [/vnd\.google-apps\.document/, 'Doc'],
  [/vnd\.google-apps\.spreadsheet/, 'Sheet'],
  [/vnd\.google-apps\.presentation/, 'Slides'],
  [/vnd\.google-apps\.drawing/, 'Drawing'],
  [/vnd\.google-apps\.form/, 'Form'],
  [/wordprocessingml/, 'DOCX'],
  [/spreadsheetml/, 'XLSX'],
  [/presentationml/, 'PPTX'],
  [/pdf/, 'PDF'],
  [/zip|x-7z|x-rar|x-tar|gzip/, 'Archive'],
  [/^image\//, 'Image'],
  [/^video\//, 'Video'],
  [/^audio\//, 'Audio'],
  [/^text\/|json|xml|javascript/, 'Text'],
]

export function fileKind(mimeType: string, name: string): string {
  for (const [pattern, label] of kindLabels) {
    if (pattern.test(mimeType)) return label
  }
  const extension = name.includes('.') ? name.split('.').pop() : null
  if (extension && extension.length <= 5) return extension.toUpperCase()
  const subtype = mimeType.split('/').at(-1) ?? 'File'
  return subtype.length > 10 ? 'File' : subtype.toUpperCase()
}
