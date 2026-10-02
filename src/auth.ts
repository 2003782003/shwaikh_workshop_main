import type { Context } from 'hono'
import type { Bindings, User } from './types'
import { getCookie } from 'hono/cookie'

// SHA-256 using Web Crypto API (works in Cloudflare Workers)
export async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const hashBuf = await crypto.subtle.digest('SHA-256', buf)
  const bytes = new Uint8Array(hashBuf)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function makeToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function getCurrentUser(c: Context<{ Bindings: Bindings }>): Promise<User | null> {
  const token = getCookie(c, 'session') || c.req.header('X-Session-Token')
  if (!token) return null
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.role, u.full_name, u.phone, u.notify_frequency
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = ?
         AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
         AND (u.deleted_at IS NULL)
         AND (u.is_active IS NULL OR u.is_active = 1)`
    ).bind(token).all<User>()
    if (!results || results.length === 0) return null
    return results[0]
  } catch {
    return null
  }
}

// Audit logging helper — records sensitive admin actions for traceability.
export async function recordAudit(
  c: Context<{ Bindings: Bindings }>,
  actor: { id: number; username?: string; role?: string },
  action: string,
  target: { type: string; id?: number | null; label?: string },
  details?: any
): Promise<void> {
  try {
    const ip =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For') ||
      c.req.header('X-Real-IP') ||
      ''
    const ua = c.req.header('User-Agent') || ''
    await c.env.DB.prepare(
      `INSERT INTO audit_log
       (actor_id, actor_username, actor_role, action, target_type, target_id, target_label, details, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      actor.id,
      actor.username || null,
      actor.role || null,
      action,
      target.type,
      target.id ?? null,
      target.label || null,
      details ? JSON.stringify(details) : null,
      ip,
      ua
    ).run()
  } catch {
    // Never let audit failures break business operations
  }
}

export async function requireRole(
  c: Context<{ Bindings: Bindings }>,
  roles: Array<'admin' | 'technician' | 'customer'>
): Promise<User | Response> {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  if (!roles.includes(user.role)) return c.json({ error: 'غير مصرح' }, 403)
  return user
}
