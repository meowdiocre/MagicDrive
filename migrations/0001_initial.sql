PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  spell_hash TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member', 'magician')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE drives (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'webdav', 's3')),
  provider_variant TEXT,
  name TEXT NOT NULL,
  root_id TEXT NOT NULL DEFAULT 'root',
  refresh_token_enc TEXT,
  config_enc TEXT,
  granted_scope TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  drive_id TEXT REFERENCES drives(id) ON DELETE CASCADE,
  virtual_drive_id TEXT CHECK (virtual_drive_id IN ('global', 'vault')),
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK (
    (virtual_drive_id IS NULL AND drive_id IS NOT NULL)
    OR (virtual_drive_id = 'global' AND drive_id IS NOT NULL)
    OR (virtual_drive_id = 'vault' AND drive_id IS NULL)
  )
);

CREATE TABLE pool_folders (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE pool_folder_drives (
  folder_id TEXT NOT NULL REFERENCES pool_folders(id) ON DELETE CASCADE,
  drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (folder_id, drive_id)
);

CREATE TABLE vault_objects (
  id TEXT PRIMARY KEY,
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  owner TEXT REFERENCES users(id) ON DELETE SET NULL,
  size INTEGER,
  content_type TEXT,
  key_enc TEXT,
  segment_size INTEGER,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading', 'ready')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE vault_segments (
  object_id TEXT NOT NULL REFERENCES vault_objects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (object_id, idx)
);

CREATE TABLE pool_deletions (
  id TEXT PRIMARY KEY,
  drive_id TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE login_attempts (
  address_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_drives_user_id ON drives(user_id);
CREATE INDEX idx_shares_drive_id ON shares(drive_id);
CREATE INDEX idx_shares_virtual_drive_id ON shares(virtual_drive_id);
CREATE INDEX idx_pool_folders_parent_path ON pool_folders(parent_path);
CREATE INDEX idx_pool_folder_drives_drive_id ON pool_folder_drives(drive_id);
CREATE INDEX idx_vault_objects_parent ON vault_objects(parent_path);
CREATE INDEX idx_vault_objects_status ON vault_objects(status);
CREATE UNIQUE INDEX idx_vault_objects_path_nocase ON vault_objects(path COLLATE NOCASE);
CREATE INDEX idx_login_attempts_expiry ON login_attempts(expires_at);

-- Deleting an owner would remove credentials needed to reconstruct their MagicVault files.
CREATE TRIGGER prevent_user_delete_with_vault_objects
BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM vault_objects WHERE owner = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Cannot delete a user while they own MagicVault objects');
END;
