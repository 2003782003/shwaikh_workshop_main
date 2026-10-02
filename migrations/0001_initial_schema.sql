-- ورشة الشويخ - Database Schema

-- Users: admin, technician, customer
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','technician','customer')),
  full_name TEXT NOT NULL,
  phone TEXT,
  notify_frequency TEXT DEFAULT 'monthly' CHECK(notify_frequency IN ('weekly','monthly','off')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Engines (المحركات)
CREATE TABLE IF NOT EXISTS engines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  technician_id INTEGER,
  engine_name TEXT NOT NULL,        -- اسم المحرك
  engine_type TEXT NOT NULL,        -- نوع المحرك (ديزل، بنزين، ...)
  power TEXT,                        -- قوة المحرك
  fault TEXT,                        -- وصف العطل
  fault_images TEXT,                 -- JSON array of data URIs
  missing_parts TEXT,                -- قطع ناقصة (نص)
  parts_list TEXT,                   -- JSON: [{name, available}]
  estimated_price REAL DEFAULT 0,
  final_price REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('cash','debt','paid','unpaid')),
  status TEXT DEFAULT 'unrepaired' CHECK(status IN ('unrepaired','in_progress','ready','delivered')),
  entry_date DATE DEFAULT CURRENT_DATE,
  expected_delivery DATE,
  delivered_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES users(id),
  FOREIGN KEY (technician_id) REFERENCES users(id)
);

-- Spare parts inventory
CREATE TABLE IF NOT EXISTS spare_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  quantity INTEGER DEFAULT 0,
  price REAL DEFAULT 0,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Messages (between customer and technician/admin)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  engine_id INTEGER,
  body TEXT,
  image_url TEXT,                    -- data URI or path
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_user_id) REFERENCES users(id),
  FOREIGN KEY (to_user_id) REFERENCES users(id),
  FOREIGN KEY (engine_id) REFERENCES engines(id)
);

-- Notifications (system + debt reminders)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  type TEXT DEFAULT 'info',          -- info, status, debt, message
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Repair reports
CREATE TABLE IF NOT EXISTS repair_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine_id INTEGER NOT NULL,
  technician_id INTEGER,
  report TEXT,
  parts_used TEXT,                   -- JSON
  labor_cost REAL DEFAULT 0,
  parts_cost REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (engine_id) REFERENCES engines(id),
  FOREIGN KEY (technician_id) REFERENCES users(id)
);

-- Backups log
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  size INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions (simple token storage)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_engines_customer ON engines(customer_id);
CREATE INDEX IF NOT EXISTS idx_engines_status ON engines(status);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
