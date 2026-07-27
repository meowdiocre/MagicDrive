ALTER TABLE drives
ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public'
CHECK (access_mode IN ('public', 'protected', 'private'));

ALTER TABLE drives
ADD COLUMN access_password_hash TEXT;
