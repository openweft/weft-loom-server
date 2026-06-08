-- weft-loom-server schema. Idempotent ; safe to run on every boot,
-- safe to run concurrently across replicas. PostgreSQL's catalog
-- DDL serialises on IF NOT EXISTS so two replicas booting at once
-- don't race.

CREATE TABLE IF NOT EXISTS projects (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_subject TEXT NOT NULL,
    name          TEXT NOT NULL,
    language      TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_subject, name)
);

CREATE INDEX IF NOT EXISTS projects_owner_idx
    ON projects (owner_subject);

-- Audit-friendly trigger : keep updated_at in sync without relying
-- on the application doing the right thing. The handler stamps a
-- timestamp on every UPDATE — used by V0.3 reconcile to decide
-- which replica has the freshest copy of a project's metadata
-- after a partition heals.
CREATE OR REPLACE FUNCTION projects_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION projects_touch_updated_at();
