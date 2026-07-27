ALTER TABLE drives
ADD COLUMN pool_contributor INTEGER NOT NULL DEFAULT 1
CHECK (pool_contributor IN (0, 1));
