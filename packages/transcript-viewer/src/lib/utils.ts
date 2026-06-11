import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function truncate(str: string | null | undefined, max: number): string {
  if (!str) return ''
  const s = String(str)
  return s.length > max ? `${s.slice(0, max)}...` : s
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}
