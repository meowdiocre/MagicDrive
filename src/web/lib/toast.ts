import { toast } from 'sonner'
import { errorMessage } from '@/api/client'

export const notify = {
  success: (message: string) => toast.success(message),
  error: (cause: unknown, fallback: string) => toast.error(errorMessage(cause, fallback)),
  message: (message: string, description?: string) => toast(message, { description }),
}
