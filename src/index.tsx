import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { setCookie, deleteCookie } from 'hono/cookie'
import type { Bindings } from './types'
import { sha256, makeToken, getCurrentUser, requireRole, recordAudit } from './auth'
import { renderApp } from './views'

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors({ origin: '*', credentials: true }))

// Global error handler — surfaces a clear Arabic message + logs the real cause
app.onError((err, c) => {
  console.error('[API ERROR]', c.req.method, c.req.path, '-', (err as any)?.message || err)
  if ((err as any)?.stack) console.error((err as any).stack)
  const path = c.req.path || ''
  if (path.startsWith('/api/')) {
    return c.json({
      error: 'حدث خطأ غير متوقع في الخادم',
      detail: (err as any)?.message || String(err),
      path
    }, 500)
  }
  return c.text('Internal Server Error', 500)
})


// ============ AUTH ============

app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>()
  if (!username || !password) return c.json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' }, 400)
  const hash = await sha256(password)
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, role, full_name, phone, notify_frequency FROM users
     WHERE username = ? AND password_hash = ?`
  ).bind(username, hash).all()
  if (!results || results.length === 0) {
    return c.json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' }, 401)
  }
  const user = results[0] as any
  const token = makeToken()
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(token, user.id, expires).run()
  setCookie(c, 'session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 7 * 24 * 3600
  })
  return c.json({ user, token })
})

app.post('/api/auth/register', async (c) => {
  const { username, password, full_name, phone } = await c.req.json<any>()
  if (!username || !password || !full_name || !phone) {
    return c.json({ error: 'جميع الحقول مطلوبة' }, 400)
  }
  // Customer self-register only
  const hash = await sha256(password)
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO users (username, password_hash, role, full_name, phone)
       VALUES (?, ?, 'customer', ?, ?)`
    ).bind(username, hash, full_name, phone).run()
    const id = res.meta.last_row_id
    const token = makeToken()
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    await c.env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
    ).bind(token, id, expires).run()
    setCookie(c, 'session', token, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 7 * 24 * 3600 })
    return c.json({ user: { id, username, role: 'customer', full_name, phone }, token })
  } catch (e: any) {
    return c.json({ error: 'اسم المستخدم مستخدم بالفعل' }, 400)
  }
})

app.post('/api/auth/logout', async (c) => {
  const token = c.req.header('Cookie')?.match(/session=([^;]+)/)?.[1]
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run()
  }
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})

app.get('/api/auth/me', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ user: null })
  return c.json({ user })
})

// ============ USERS (Admin) ============

app.get('/api/users', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const role = c.req.query('role')
  const q = c.req.query('q')
  const includeInactive = c.req.query('include_inactive') === '1' && user.role === 'admin'
  let sql = `SELECT id, username, role, full_name, phone, notify_frequency, created_at,
             COALESCE(is_active, 1) AS is_active, deleted_at, password_updated_at
             FROM users WHERE 1=1`
  const binds: any[] = []
  if (!includeInactive) sql += ' AND deleted_at IS NULL AND (is_active IS NULL OR is_active = 1)'
  if (role) { sql += ' AND role = ?'; binds.push(role) }
  if (q) { sql += ' AND (full_name LIKE ? OR phone LIKE ? OR username LIKE ?)'; binds.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  sql += ' ORDER BY created_at DESC'
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ users: results || [] })
})

// ============ ADMIN PROFILE: Change own password ============
app.post('/api/auth/change-password', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  const { current_password, new_password } = await c.req.json<any>()
  if (!current_password || !new_password) {
    return c.json({ error: 'الحقول مطلوبة' }, 400)
  }
  // Server-side password strength validation (defense-in-depth)
  if (new_password.length < 8) return c.json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' }, 400)
  if (!/[A-Z]/.test(new_password)) return c.json({ error: 'يجب أن تحتوي على حرف كبير' }, 400)
  if (!/[a-z]/.test(new_password)) return c.json({ error: 'يجب أن تحتوي على حرف صغير' }, 400)
  if (!/[0-9]/.test(new_password)) return c.json({ error: 'يجب أن تحتوي على رقم' }, 400)
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(new_password)) return c.json({ error: 'يجب أن تحتوي على رمز خاص' }, 400)
  if (current_password === new_password) return c.json({ error: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية' }, 400)

  // Verify current password
  const curHash = await sha256(current_password)
  const { results } = await c.env.DB.prepare(
    'SELECT id FROM users WHERE id = ? AND password_hash = ?'
  ).bind(user.id, curHash).all<any>()
  if (!results || results.length === 0) {
    return c.json({ error: 'كلمة المرور الحالية غير صحيحة' }, 400)
  }
  const newHash = await sha256(new_password)
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(newHash, user.id).run()

  // Invalidate all OTHER sessions for this user (force re-login on other devices)
  const currentToken = c.req.header('Cookie')?.match(/session=([^;]+)/)?.[1]
  if (currentToken) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, currentToken).run()
  }

  await recordAudit(c, user, 'change_password', { type: 'self', id: user.id, label: user.username }, {})
  return c.json({ ok: true, password_updated_at: new Date().toISOString() })
})

// Get current admin profile (with password_updated_at)
app.get('/api/auth/profile', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, role, full_name, phone, notify_frequency,
            created_at, updated_at, password_updated_at
     FROM users WHERE id = ?`
  ).bind(user.id).all<any>()
  return c.json({ profile: results?.[0] || null })
})

// ============ AUDIT LOG (admin only) ============
app.get('/api/audit-log', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const limit = Math.min(Number(c.req.query('limit') || 100), 500)
  const action = c.req.query('action')
  let sql = `SELECT * FROM audit_log WHERE 1=1`
  const binds: any[] = []
  if (action) { sql += ' AND action = ?'; binds.push(action) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  binds.push(limit)
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ entries: results || [] })
})

app.post('/api/users', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const { username, password, role, full_name, phone, notify_frequency } = await c.req.json<any>()
  if (!username || !password || !role || !full_name) {
    return c.json({ error: 'الحقول المطلوبة ناقصة' }, 400)
  }
  const hash = await sha256(password)
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO users (username, password_hash, role, full_name, phone, notify_frequency)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, 'monthly'))`
    ).bind(username, hash, role, full_name, phone || null, notify_frequency || null).run()
    return c.json({ id: res.meta.last_row_id })
  } catch {
    return c.json({ error: 'اسم المستخدم موجود مسبقاً' }, 400)
  }
})

app.put('/api/users/:id', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  const { full_name, phone, notify_frequency, password, role } = await c.req.json<any>()
  const sets: string[] = []
  const binds: any[] = []
  if (full_name) { sets.push('full_name = ?'); binds.push(full_name) }
  if (phone !== undefined) { sets.push('phone = ?'); binds.push(phone) }
  if (notify_frequency) { sets.push('notify_frequency = ?'); binds.push(notify_frequency) }
  if (role) { sets.push('role = ?'); binds.push(role) }
  if (password) { sets.push('password_hash = ?'); binds.push(await sha256(password)) }
  sets.push("updated_at = datetime('now')")
  if (sets.length === 1) return c.json({ error: 'لا يوجد تحديثات' }, 400)
  binds.push(id)
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  return c.json({ ok: true })
})

// Pre-flight check before deleting a user — returns dependency info so the
// admin can take an informed decision (transfer / archive / cancel).
app.get('/api/users/:id/delete-impact', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, username, role, full_name, phone, COALESCE(is_active, 1) AS is_active, deleted_at
     FROM users WHERE id = ?`
  ).bind(id).all<any>()
  if (!rows || !rows.length) return c.json({ error: 'المستخدم غير موجود' }, 404)
  const target = rows[0]

  // Active engines = anything not yet delivered AND not archived
  const { results: activeEngRows } = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM engines
     WHERE (is_archived IS NULL OR is_archived = 0)
       AND status IN ('unrepaired','in_progress','ready')
       AND (customer_id = ? OR technician_id = ?)`
  ).bind(id, id).all<any>()
  const { results: totalEngRows } = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM engines WHERE customer_id = ? OR technician_id = ?`
  ).bind(id, id).all<any>()
  const { results: msgRows } = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM messages WHERE from_user_id = ? OR to_user_id = ?`
  ).bind(id, id).all<any>()

  return c.json({
    user: target,
    active_engines: Number(activeEngRows?.[0]?.c || 0),
    total_engines: Number(totalEngRows?.[0]?.c || 0),
    messages: Number(msgRows?.[0]?.c || 0)
  })
})

// Disable (deactivate) a user — soft-disable before final deletion.
app.post('/api/users/:id/disable', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  if (id === user.id) return c.json({ error: 'لا يمكن تعطيل حسابك' }, 400)
  const { results } = await c.env.DB.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(id).all<any>()
  if (!results || !results.length) return c.json({ error: 'غير موجود' }, 404)
  await c.env.DB.prepare(
    `UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run()
  // End all active sessions for the disabled user
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
  await recordAudit(c, user, 'disable_user',
    { type: 'user', id, label: results[0].full_name }, { username: results[0].username })
  return c.json({ ok: true })
})

// Re-activate a disabled user
app.post('/api/users/:id/enable', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    `UPDATE users SET is_active = 1, updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run()
  await recordAudit(c, user, 'enable_user', { type: 'user', id }, {})
  return c.json({ ok: true })
})

// Transfer all engines from one technician to another
app.post('/api/users/:id/transfer-engines', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const fromId = Number(c.req.param('id'))
  const { to_technician_id } = await c.req.json<any>()
  if (!to_technician_id) return c.json({ error: 'الفني الجديد مطلوب' }, 400)
  if (Number(to_technician_id) === fromId) return c.json({ error: 'يجب اختيار فني مختلف' }, 400)
  const { results: tech } = await c.env.DB.prepare(
    `SELECT id, role, full_name FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(to_technician_id).all<any>()
  if (!tech || !tech.length || (tech[0].role !== 'technician' && tech[0].role !== 'admin')) {
    return c.json({ error: 'الفني المستلم غير صالح' }, 400)
  }
  const res = await c.env.DB.prepare(
    `UPDATE engines SET technician_id = ?, updated_at = datetime('now') WHERE technician_id = ?`
  ).bind(to_technician_id, fromId).run()
  await recordAudit(c, user, 'transfer_engines',
    { type: 'user', id: fromId, label: tech[0].full_name },
    { to_technician_id, count: res.meta?.changes || 0 })
  return c.json({ ok: true, transferred: res.meta?.changes || 0 })
})

app.delete('/api/users/:id', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  if (id === user.id) return c.json({ error: 'لا يمكن حذف نفسك' }, 400)

  const force = c.req.query('force') === '1'

  // Get target snapshot for audit before deletion
  const { results: tgt } = await c.env.DB.prepare(
    `SELECT id, username, role, full_name, phone, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?`
  ).bind(id).all<any>()
  if (!tgt || !tgt.length) return c.json({ error: 'المستخدم غير موجود' }, 404)
  const target = tgt[0]

  // Safety check: technicians with active engines cannot be deleted unless force=1 (after transfer)
  if (target.role === 'technician') {
    const { results: act } = await c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM engines
       WHERE technician_id = ?
         AND (is_archived IS NULL OR is_archived = 0)
         AND status IN ('unrepaired','in_progress','ready')`
    ).bind(id).all<any>()
    if (Number(act?.[0]?.c || 0) > 0 && !force) {
      return c.json({
        error: 'لا يمكن حذف هذا الفني — لديه مهام نشطة. قم بنقل المهام أولاً ثم أعد المحاولة.',
        active_engines: Number(act[0].c)
      }, 409)
    }
  }

  // Customers with engines: keep engines but mark soft-delete on user (preserve history)
  // Technicians: only delete after force/transfer; engines keep technician_id reference
  const { results: hasData } = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM engines WHERE customer_id = ? OR technician_id = ?) AS engines_count,
      (SELECT COUNT(*) FROM messages WHERE from_user_id = ? OR to_user_id = ?) AS messages_count`
  ).bind(id, id, id, id).all<any>()

  const engCnt = Number(hasData?.[0]?.engines_count || 0)
  const msgCnt = Number(hasData?.[0]?.messages_count || 0)

  if (engCnt > 0 || msgCnt > 0) {
    // Soft delete to preserve referential integrity & history
    await c.env.DB.prepare(
      `UPDATE users SET deleted_at = datetime('now'), deleted_by = ?, is_active = 0,
        username = username || '_deleted_' || ?,
        updated_at = datetime('now')
       WHERE id = ?`
    ).bind(user.id, Date.now(), id).run()
    await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
    await recordAudit(c, user, 'soft_delete_user',
      { type: 'user', id, label: target.full_name },
      { username: target.username, role: target.role, engines: engCnt, messages: msgCnt })
    return c.json({ ok: true, mode: 'soft' })
  }

  // No related data → hard delete
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
  await recordAudit(c, user, 'hard_delete_user',
    { type: 'user', id, label: target.full_name },
    { username: target.username, role: target.role })
  return c.json({ ok: true, mode: 'hard' })
})

// ============ ENGINES ============

app.get('/api/engines', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  const status = c.req.query('status')
  const includeArchived = c.req.query('archived') === '1' && user.role === 'admin'
  let sql = `SELECT e.*, u.full_name AS customer_name, u.phone AS customer_phone,
             t.full_name AS technician_name
             FROM engines e
             JOIN users u ON u.id = e.customer_id
             LEFT JOIN users t ON t.id = e.technician_id
             WHERE 1=1`
  const binds: any[] = []
  if (!includeArchived) sql += ' AND (e.is_archived IS NULL OR e.is_archived = 0)'
  if (user.role === 'customer') { sql += ' AND e.customer_id = ?'; binds.push(user.id) }
  if (status) { sql += ' AND e.status = ?'; binds.push(status) }
  sql += ' ORDER BY e.created_at DESC'
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ engines: results || [] })
})

app.get('/api/engines/:id', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  const id = Number(c.req.param('id'))
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, u.full_name AS customer_name, u.phone AS customer_phone, u.username AS customer_username,
     t.full_name AS technician_name
     FROM engines e JOIN users u ON u.id = e.customer_id
     LEFT JOIN users t ON t.id = e.technician_id WHERE e.id = ?`
  ).bind(id).all<any>()
  if (!results || !results.length) return c.json({ error: 'غير موجود' }, 404)
  const eng = results[0]
  if (user.role === 'customer' && eng.customer_id !== user.id) {
    return c.json({ error: 'غير مصرح' }, 403)
  }
  return c.json({ engine: eng })
})

app.post('/api/engines', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const body = await c.req.json<any>()
  const {
    customer_id, engine_name, engine_type, power,
    fault, fault_images, missing_parts, parts_list,
    estimated_price, entry_date, expected_delivery
  } = body
  if (!customer_id || !engine_name || !engine_type) {
    return c.json({ error: 'حقول إلزامية ناقصة' }, 400)
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO engines (customer_id, technician_id, engine_name, engine_type, power,
      fault, fault_images, missing_parts, parts_list, estimated_price,
      entry_date, expected_delivery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?)`
  ).bind(
    customer_id, user.role === 'technician' ? user.id : null,
    engine_name, engine_type, power || null,
    fault || null, fault_images ? JSON.stringify(fault_images) : null,
    missing_parts || null, parts_list ? JSON.stringify(parts_list) : null,
    estimated_price || 0, entry_date || null, expected_delivery || null
  ).run()
  const engineId = res.meta.last_row_id
  // Create notification for customer
  await c.env.DB.prepare(
    `INSERT INTO notifications (user_id, title, body, type)
     VALUES (?, ?, ?, 'status')`
  ).bind(customer_id, 'تم تسجيل محرك جديد', `تم تسجيل المحرك "${engine_name}" في الورشة.`).run()
  return c.json({ id: engineId })
})

app.put('/api/engines/:id', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  const body = await c.req.json<any>()
  const fields = [
    'engine_name', 'engine_type', 'power', 'fault',
    'missing_parts', 'estimated_price', 'final_price', 'paid_amount',
    'payment_status', 'status', 'expected_delivery', 'repair_notes'
  ]
  const sets: string[] = []
  const binds: any[] = []
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); binds.push(body[f]) }
  }
  if (body.fault_images) { sets.push('fault_images = ?'); binds.push(JSON.stringify(body.fault_images)) }
  if (body.parts_list) { sets.push('parts_list = ?'); binds.push(JSON.stringify(body.parts_list)) }
  if (body.status === 'delivered') { sets.push("delivered_at = datetime('now')") }
  sets.push("updated_at = datetime('now')")
  if (sets.length === 1) return c.json({ error: 'لا يوجد تحديثات' }, 400)
  binds.push(id)
  await c.env.DB.prepare(`UPDATE engines SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  // Notify customer
  if (body.status) {
    const { results } = await c.env.DB.prepare('SELECT customer_id, engine_name FROM engines WHERE id = ?').bind(id).all<any>()
    if (results && results[0]) {
      const statusMap: any = {
        in_progress: 'قيد التصليح',
        ready: 'جاهز للاستلام',
        delivered: 'تم التسليم',
        unrepaired: 'غير مصلح بعد'
      }
      await c.env.DB.prepare(
        `INSERT INTO notifications (user_id, title, body, type) VALUES (?, ?, ?, 'status')`
      ).bind(results[0].customer_id, 'تحديث حالة محرك', `المحرك "${results[0].engine_name}" — الحالة: ${statusMap[body.status] || body.status}`).run()
    }
  }
  return c.json({ ok: true })
})

// Pre-flight check before deleting an engine — returns dependency info
app.get('/api/engines/:id/delete-impact', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  const { results: engRows } = await c.env.DB.prepare(
    `SELECT e.*, u.full_name AS customer_name FROM engines e
     JOIN users u ON u.id = e.customer_id WHERE e.id = ?`
  ).bind(id).all<any>()
  if (!engRows || !engRows.length) return c.json({ error: 'المحرك غير موجود' }, 404)
  const eng = engRows[0]

  const { results: rep } = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM repair_reports WHERE engine_id = ?`
  ).bind(id).all<any>()
  const hasHistory =
    (eng.delivered_at != null) ||
    (Number(eng.paid_amount || 0) > 0) ||
    (eng.status === 'delivered') ||
    (Number(rep?.[0]?.c || 0) > 0)

  return c.json({
    engine: eng,
    has_payments: Number(eng.paid_amount || 0) > 0,
    has_reports: Number(rep?.[0]?.c || 0),
    delivered: eng.status === 'delivered' || eng.delivered_at != null,
    has_history: hasHistory,
    recommended_action: hasHistory ? 'archive' : 'delete',
    affects_stats: hasHistory
  })
})

// Archive an engine (preserve history)
app.post('/api/engines/:id/archive', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  const { reason } = await c.req.json<any>().catch(() => ({}))
  const { results } = await c.env.DB.prepare(
    `SELECT engine_name, customer_id FROM engines WHERE id = ?`
  ).bind(id).all<any>()
  if (!results || !results.length) return c.json({ error: 'غير موجود' }, 404)
  await c.env.DB.prepare(
    `UPDATE engines SET is_archived = 1, archived_at = datetime('now'),
       archived_by = ?, archive_reason = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(user.id, reason || null, id).run()
  await recordAudit(c, user, 'archive_engine',
    { type: 'engine', id, label: results[0].engine_name }, { reason: reason || null })
  return c.json({ ok: true })
})

// Restore an archived engine
app.post('/api/engines/:id/unarchive', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    `UPDATE engines SET is_archived = 0, archived_at = NULL, archived_by = NULL,
       archive_reason = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(id).run()
  await recordAudit(c, user, 'unarchive_engine', { type: 'engine', id }, {})
  return c.json({ ok: true })
})

app.delete('/api/engines/:id', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  const force = c.req.query('force') === '1'
  const reason = c.req.query('reason') || ''

  const { results } = await c.env.DB.prepare(
    `SELECT e.*, u.full_name AS customer_name FROM engines e
     JOIN users u ON u.id = e.customer_id WHERE e.id = ?`
  ).bind(id).all<any>()
  if (!results || !results.length) return c.json({ error: 'المحرك غير موجود' }, 404)
  const eng = results[0]

  // History check — refuse hard delete unless force=1
  const hasHistory =
    (eng.delivered_at != null) ||
    (Number(eng.paid_amount || 0) > 0) ||
    (eng.status === 'delivered')
  if (hasHistory && !force) {
    return c.json({
      error: 'هذا المحرك يملك بيانات تاريخية (دفعات/تسليم). يُنصح بالأرشفة بدلاً من الحذف.',
      recommended_action: 'archive'
    }, 409)
  }

  await c.env.DB.prepare('DELETE FROM repair_reports WHERE engine_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM engines WHERE id = ?').bind(id).run()
  await recordAudit(c, user, 'delete_engine',
    { type: 'engine', id, label: eng.engine_name },
    {
      customer_id: eng.customer_id,
      customer_name: eng.customer_name,
      status: eng.status,
      paid_amount: eng.paid_amount,
      reason: reason || null,
      forced: force
    })
  return c.json({ ok: true })
})

// ============ MESSAGES ============

app.get('/api/messages', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  const withUser = c.req.query('with')
  let sql: string
  let binds: any[]
  if (withUser) {
    sql = `SELECT m.*, u1.full_name AS from_name, u2.full_name AS to_name
           FROM messages m JOIN users u1 ON u1.id = m.from_user_id JOIN users u2 ON u2.id = m.to_user_id
           WHERE (m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?)
           ORDER BY m.created_at ASC`
    binds = [user.id, Number(withUser), Number(withUser), user.id]
    // mark as read
    await c.env.DB.prepare('UPDATE messages SET is_read = 1 WHERE to_user_id = ? AND from_user_id = ?')
      .bind(user.id, Number(withUser)).run()
  } else {
    // Get all conversations
    sql = `SELECT m.*, u1.full_name AS from_name, u2.full_name AS to_name
           FROM messages m JOIN users u1 ON u1.id = m.from_user_id JOIN users u2 ON u2.id = m.to_user_id
           WHERE m.from_user_id = ? OR m.to_user_id = ?
           ORDER BY m.created_at DESC`
    binds = [user.id, user.id]
  }
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ messages: results || [] })
})

app.get('/api/messages/conversations', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  // For customer: list all admin+technician. For staff: list all customers they messaged or ever.
  let sql: string
  let binds: any[]
  if (user.role === 'customer') {
    sql = `SELECT u.id, u.full_name, u.role,
             (SELECT body FROM messages m WHERE (m.from_user_id = u.id AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = u.id) ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT COUNT(*) FROM messages m WHERE m.from_user_id = u.id AND m.to_user_id = ? AND m.is_read = 0) AS unread
           FROM users u WHERE u.role IN ('admin','technician')
             AND u.deleted_at IS NULL AND (u.is_active IS NULL OR u.is_active = 1)
           ORDER BY u.role DESC`
    binds = [user.id, user.id, user.id]
  } else {
    sql = `SELECT u.id, u.full_name, u.role,
             (SELECT body FROM messages m WHERE (m.from_user_id = u.id AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = u.id) ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT COUNT(*) FROM messages m WHERE m.from_user_id = u.id AND m.to_user_id = ? AND m.is_read = 0) AS unread
           FROM users u WHERE u.role = 'customer'
             AND u.deleted_at IS NULL AND (u.is_active IS NULL OR u.is_active = 1)
           ORDER BY u.full_name`
    binds = [user.id, user.id, user.id]
  }
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ conversations: results || [] })
})

app.post('/api/messages', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  const { to_user_id, body, image_url, engine_id } = await c.req.json<any>()
  if (!to_user_id || (!body && !image_url)) return c.json({ error: 'بيانات ناقصة' }, 400)
  const res = await c.env.DB.prepare(
    `INSERT INTO messages (from_user_id, to_user_id, engine_id, body, image_url)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(user.id, to_user_id, engine_id || null, body || null, image_url || null).run()
  // Create notification
  await c.env.DB.prepare(
    `INSERT INTO notifications (user_id, title, body, type) VALUES (?, ?, ?, 'message')`
  ).bind(to_user_id, `رسالة جديدة من ${user.full_name}`, (body || '[صورة]').slice(0, 100)).run()
  return c.json({ id: res.meta.last_row_id })
})

app.get('/api/messages/unread-count', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ count: 0 })
  const { results } = await c.env.DB.prepare(
    'SELECT COUNT(*) AS c FROM messages WHERE to_user_id = ? AND is_read = 0'
  ).bind(user.id).all<any>()
  return c.json({ count: results?.[0]?.c || 0 })
})

// ============ NOTIFICATIONS ============

app.get('/api/notifications', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ notifications: [] })
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(user.id).all()
  return c.json({ notifications: results || [] })
})

app.post('/api/notifications/read', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').bind(user.id).run()
  return c.json({ ok: true })
})

// ============ DEBTS / PAYMENTS ============

app.get('/api/debts', async (c) => {
  const user = await getCurrentUser(c)
  if (!user) return c.json({ error: 'غير مصادق' }, 401)
  let sql = `SELECT e.id, e.engine_name, e.engine_type, e.final_price, e.paid_amount, e.payment_status,
             (e.final_price - e.paid_amount) AS remaining,
             u.full_name AS customer_name, u.phone AS customer_phone, u.id AS customer_id
             FROM engines e JOIN users u ON u.id = e.customer_id
             WHERE e.final_price > e.paid_amount`
  const binds: any[] = []
  if (user.role === 'customer') { sql += ' AND e.customer_id = ?'; binds.push(user.id) }
  sql += ' ORDER BY e.created_at DESC'
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
  return c.json({ debts: results || [] })
})

app.post('/api/debts/pay', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const { engine_id, amount, payment_status } = await c.req.json<any>()
  if (!engine_id || amount === undefined) return c.json({ error: 'بيانات ناقصة' }, 400)
  await c.env.DB.prepare(
    `UPDATE engines SET paid_amount = paid_amount + ?, payment_status = COALESCE(?, payment_status),
     updated_at = datetime('now') WHERE id = ?`
  ).bind(amount, payment_status || null, engine_id).run()
  return c.json({ ok: true })
})

// Send debt reminders (admin/technician only)
app.post('/api/debts/remind', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const { customer_id } = await c.req.json<any>()
  if (!customer_id) return c.json({ error: 'معرّف الزبون مطلوب' }, 400)
  const { results } = await c.env.DB.prepare(
    `SELECT SUM(final_price - paid_amount) AS debt FROM engines WHERE customer_id = ? AND final_price > paid_amount`
  ).bind(customer_id).all<any>()
  const amount = results?.[0]?.debt || 0
  await c.env.DB.prepare(
    `INSERT INTO notifications (user_id, title, body, type)
     VALUES (?, 'تذكير بالدين المستحق', ?, 'debt')`
  ).bind(customer_id, `لديك دين مستحق بمبلغ ${amount} دج. يُرجى التواصل مع الورشة لتسديده.`).run()
  return c.json({ ok: true, amount })
})

// ============ SPARE PARTS ============

app.get('/api/spare-parts', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const { results } = await c.env.DB.prepare('SELECT * FROM spare_parts ORDER BY name').all()
  return c.json({ parts: results || [] })
})

app.post('/api/spare-parts', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const { name, quantity, price, notes } = await c.req.json<any>()
  if (!name) return c.json({ error: 'الاسم مطلوب' }, 400)
  const res = await c.env.DB.prepare(
    'INSERT INTO spare_parts (name, quantity, price, notes) VALUES (?, ?, ?, ?)'
  ).bind(name, quantity || 0, price || 0, notes || null).run()
  return c.json({ id: res.meta.last_row_id })
})

app.put('/api/spare-parts/:id', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  const { name, quantity, price, notes } = await c.req.json<any>()
  await c.env.DB.prepare(
    'UPDATE spare_parts SET name = COALESCE(?, name), quantity = COALESCE(?, quantity), price = COALESCE(?, price), notes = COALESCE(?, notes) WHERE id = ?'
  ).bind(name || null, quantity ?? null, price ?? null, notes || null, id).run()
  return c.json({ ok: true })
})

app.delete('/api/spare-parts/:id', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM spare_parts WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

// ============ REPORTS / STATS ============

app.get('/api/stats', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const queries = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS c FROM engines WHERE (is_archived IS NULL OR is_archived = 0)').all<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS c FROM engines WHERE status = 'unrepaired' AND (is_archived IS NULL OR is_archived = 0)").all<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS c FROM engines WHERE status = 'in_progress' AND (is_archived IS NULL OR is_archived = 0)").all<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS c FROM engines WHERE status = 'ready' AND (is_archived IS NULL OR is_archived = 0)").all<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS c FROM engines WHERE status = 'delivered' AND (is_archived IS NULL OR is_archived = 0)").all<any>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(final_price - paid_amount), 0) AS total FROM engines WHERE final_price > paid_amount AND (is_archived IS NULL OR is_archived = 0)").all<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'customer' AND deleted_at IS NULL AND (is_active IS NULL OR is_active = 1)").all<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'technician' AND deleted_at IS NULL AND (is_active IS NULL OR is_active = 1)").all<any>(),
  ])
  return c.json({
    total_engines: queries[0].results?.[0]?.c || 0,
    unrepaired: queries[1].results?.[0]?.c || 0,
    in_progress: queries[2].results?.[0]?.c || 0,
    ready: queries[3].results?.[0]?.c || 0,
    delivered: queries[4].results?.[0]?.c || 0,
    total_debt: queries[5].results?.[0]?.total || 0,
    customers: queries[6].results?.[0]?.c || 0,
    technicians: queries[7].results?.[0]?.c || 0
  })
})

app.get('/api/reports', async (c) => {
  const user = await requireRole(c, ['admin', 'technician'])
  if (user instanceof Response) return user
  const { results: monthly } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS engines,
     SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
     COALESCE(SUM(final_price), 0) AS revenue
     FROM engines GROUP BY month ORDER BY month DESC LIMIT 12`
  ).all()
  const { results: recent } = await c.env.DB.prepare(
    `SELECT e.*, u.full_name AS customer_name FROM engines e JOIN users u ON u.id = e.customer_id ORDER BY e.created_at DESC LIMIT 20`
  ).all()
  return c.json({ monthly: monthly || [], recent: recent || [] })
})

// ============ BACKUP ============

app.get('/api/backup', async (c) => {
  const user = await requireRole(c, ['admin'])
  if (user instanceof Response) return user
  const tables = ['users', 'engines', 'messages', 'notifications', 'spare_parts', 'repair_reports']
  const backup: any = { created_at: new Date().toISOString() }
  for (const t of tables) {
    const { results } = await c.env.DB.prepare(`SELECT * FROM ${t}`).all()
    backup[t] = results || []
  }
  const json = JSON.stringify(backup, null, 2)
  await c.env.DB.prepare('INSERT INTO backups (file_name, size) VALUES (?, ?)')
    .bind(`backup_${Date.now()}.json`, json.length).run()
  return new Response(json, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="backup_${new Date().toISOString().slice(0,10)}.json"`
    }
  })
})

// ============ HTML PAGES ============
app.get('*', (c) => c.html(renderApp()))

export default app
