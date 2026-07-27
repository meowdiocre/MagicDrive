export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function parseResponse<T>(response: Response, fallbackError: string): Promise<T> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(payload?.error || fallbackError, response.status)
  return payload.data as T
}

export async function apiGet<T>(url: string, fallbackError: string): Promise<T> {
  return parseResponse(await fetch(url), fallbackError)
}

export async function apiPost<T>(url: string, body: unknown, fallbackError: string): Promise<T> {
  return parseResponse(await fetch(url, jsonInit('POST', body)), fallbackError)
}

export async function apiPatch<T>(url: string, body: unknown, fallbackError: string): Promise<T> {
  return parseResponse(await fetch(url, jsonInit('PATCH', body)), fallbackError)
}

export async function apiDelete<T>(url: string, fallbackError: string): Promise<T> {
  return parseResponse(await fetch(url, { method: 'DELETE' }), fallbackError)
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}
