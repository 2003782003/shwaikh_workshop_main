-- Audit log for tracking sensitive admin actions (deletes, password changes, archives)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,                    -- User performing the action
  actor_username TEXT,                          -- Snapshot
  actor_role TEXT,                              -- Snapshot
  action TEXT NOT NULL,                         -- e.g., 'delete_user', 'archive_engine', 'change_password'
  target_type TEXT NOT NULL,                    -- 'user', 'engine', 'self', etc.
  target_id INTEGER,                            -- ID of the affected entity
  target_label TEXT,                            -- Human-readable label (name, etc.)
  details TEXT,                                 -- JSON snapshot of relevant info
  ip_address TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Track when a user's password was last changed
ALTER TABLE users ADD COLUMN password_updated_at DATETIME;

-- Soft delete & disable flags for users (admins can disable before delete)
ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN deleted_at DATETIME;
ALTER TABLE users ADD COLUMN deleted_by INTEGER;

-- Archive flag for engines (preserve history while hiding from main lists)
ALTER TABLE engines ADD COLUMN is_archived INTEGER DEFAULT 0;
ALTER TABLE engines ADD COLUMN archived_at DATETIME;
ALTER TABLE engines ADD COLUMN archived_by INTEGER;
ALTER TABLE engines ADD COLUMN archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active, deleted_at);
CREATE INDEX IF NOT EXISTS idx_engines_archived ON engines(is_archived);

-- Initialize password_updated_at for existing users
UPDATE users SET password_updated_at = COALESCE(updated_at, created_at) WHERE password_updated_at IS NULL;
