ALTER TABLE vault_objects
ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public'
CHECK (access_mode IN ('public', 'protected', 'private'));

ALTER TABLE vault_objects
ADD COLUMN access_password_hash TEXT;

ALTER TABLE pool_folders
ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public'
CHECK (access_mode IN ('public', 'protected', 'private'));

ALTER TABLE pool_folders
ADD COLUMN access_password_hash TEXT;

CREATE TABLE shares_rebuilt (
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
    OR virtual_drive_id = 'global'
    OR (virtual_drive_id = 'vault' AND drive_id IS NULL)
  )
);

INSERT INTO shares_rebuilt
SELECT id, drive_id, virtual_drive_id, file_id, name, token_hash, expires_at, created_by, created_at
FROM shares;

DROP TABLE shares;
ALTER TABLE shares_rebuilt RENAME TO shares;
CREATE INDEX idx_shares_drive_id ON shares(drive_id);
CREATE INDEX idx_shares_virtual_drive_id ON shares(virtual_drive_id);

CREATE TABLE pool_objects (
  id TEXT PRIMARY KEY,
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  owner TEXT REFERENCES users(id) ON DELETE SET NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  segment_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading', 'ready')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pool_segments (
  object_id TEXT NOT NULL REFERENCES pool_objects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (object_id, idx)
);

CREATE INDEX idx_pool_objects_parent ON pool_objects(parent_path);
CREATE INDEX idx_pool_objects_status ON pool_objects(status);
CREATE UNIQUE INDEX idx_pool_objects_path_nocase ON pool_objects(path COLLATE NOCASE);
CREATE INDEX idx_pool_segments_drive_id ON pool_segments(drive_id);

CREATE TRIGGER prevent_user_delete_with_managed_segments
BEFORE DELETE ON users
WHEN EXISTS (
  SELECT 1 FROM drives d
  WHERE d.user_id = OLD.id
    AND (
      EXISTS (SELECT 1 FROM vault_segments WHERE drive_id = d.id)
      OR EXISTS (SELECT 1 FROM pool_segments WHERE drive_id = d.id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Cannot delete a user while their storage holds managed segments');
END;
