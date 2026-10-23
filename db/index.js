import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the data directory exists
const dataDir = path.resolve(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'talks.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency and write performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
  console.log(`[DB] Initializing SQLite database at: ${dbPath}`);

  // 1. Channels Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uploads_playlist_id TEXT NOT NULL,
      category_hint TEXT DEFAULT 'general',
      min_duration_sec INTEGER DEFAULT 480,
      last_synced_at TEXT,
      active INTEGER DEFAULT 1
    );
  `);

  // 2. Talks Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS talks (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      speaker TEXT,
      description TEXT,
      duration_sec INTEGER NOT NULL,
      duration_formatted TEXT,
      thumbnail_url TEXT,
      published_at TEXT,
      view_count INTEGER DEFAULT 0,
      summary TEXT,
      tags TEXT, -- JSON array of strings
      embedding TEXT, -- JSON array of vector numbers
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_talks_channel ON talks(channel_id);
    CREATE INDEX IF NOT EXISTS idx_talks_published ON talks(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_talks_duration ON talks(duration_sec);
  `);

  // 3. Full-Text Search Virtual Table (FTS5) for Talks
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS talks_fts USING fts5(
      video_id UNINDEXED,
      title,
      speaker,
      description,
      summary,
      tags,
      tokenize = 'porter unicode61'
    );
  `);

  // 4. Learning Paths Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_paths (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      goal_text TEXT NOT NULL,
      title TEXT NOT NULL,
      overview TEXT,
      slug TEXT UNIQUE NOT NULL,
      is_public INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_paths_slug ON learning_paths(slug);
    CREATE INDEX IF NOT EXISTS idx_paths_user ON learning_paths(user_id);
  `);

  // 5. Path Items (The 5 to 7 ordered talks in a path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS path_items (
      id TEXT PRIMARY KEY,
      path_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      why_this_talk TEXT,
      key_takeaway TEXT,
      action_step TEXT,
      is_watched INTEGER DEFAULT 0,
      FOREIGN KEY (path_id) REFERENCES learning_paths(id) ON DELETE CASCADE,
      FOREIGN KEY (video_id) REFERENCES talks(video_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_path_items_path ON path_items(path_id, position);
  `);

  // 6. Usage Log (For Rate Limits & Plan Tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_usage_log ON usage_log(identifier, action, created_at);
  `);

  console.log('[DB] Database tables and indexes ready.');
}

export default db;
