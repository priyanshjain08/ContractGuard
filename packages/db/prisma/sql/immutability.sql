-- Defense in depth: spec versions are append-only at the database level too.
-- Apply after the Prisma migration. Project deletion is allowed to cascade because the session
-- sets `contractguard.allow_version_delete` only inside the project-deletion transaction.
CREATE OR REPLACE FUNCTION cg_spec_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'SpecVersion rows are immutable';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('contractguard.allow_version_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'SpecVersion rows cannot be deleted';
  END IF;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS spec_version_immutable ON "SpecVersion";
CREATE TRIGGER spec_version_immutable BEFORE UPDATE OR DELETE ON "SpecVersion"
  FOR EACH ROW EXECUTE FUNCTION cg_spec_version_immutable();
