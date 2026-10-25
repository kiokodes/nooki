-- Repair every push webhook in one place. Three things were wrong on the live project:
--
-- 1. "I miss you" had NO webhook at all. The send-push function has handled
--    miss_you_taps since 2026-10-21, but nothing ever called it, so a tap could never
--    knock on the partner's phone. This adds both the Insert and the Update webhook.
-- 2. The letters' knock was never in a migration at all — it only ever existed in the
--    README and in the dashboard — and it covered only Update. Both triggers are created
--    here, so a rebuilt project gets them: Update fires on the NULL -> sealed transition
--    (a draft autosave says nothing, and a recalled letter keeps its one knock), and
--    Insert is WHEN (sealed_at IS NOT NULL) so a letter that is born sealed still knocks
--    without ever announcing a draft.
-- 3. Removing the Together-time tab left its pg_cron sweep running. Once a minute,
--    every minute, it POSTed table 'together_time_sessions' to send-push and collected
--    "not a watched table" — 1,440 dead requests a day. Unscheduled here.
--
-- Supabase Database Webhooks are dashboard objects, not rows in a migration, and there
-- is no API to create one from SQL. So rather than hard-code the project URL and the
-- push secret, this migration *reads them off a webhook that already works* and builds
-- the missing triggers with the same endpoint and the same Authorization header. That
-- keeps one secret, in one place, out of the repository.
--
-- On a project with no webhooks yet (a fresh install) there is nothing to copy from, so
-- the migration says so and does nothing: create the webhooks in Dashboard → Database →
-- Webhooks as README "Turning it on" describes, then run this again to pick up the two
-- triggers the dashboard cannot express.
--
-- Safe to rerun: every trigger is dropped-if-exists first.
BEGIN;

DO $fix_push_webhooks$
DECLARE
  v_url     TEXT;
  v_secret  TEXT;
  v_headers JSONB;
  v_sources INT;
  v_distinct INT;
  v_job     INT;
BEGIN
  -- 3. Always do this, even on a project with no webhooks: the sweep is dead code.
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_job IN
      SELECT jobid FROM cron.job
      WHERE command ILIKE '%invoke_together_time_reminder_sweep%'
         OR jobname = 'nooki-together-time-reminders'
    LOOP
      PERFORM cron.unschedule(v_job);
    END LOOP;
  END IF;

  IF to_regproc('supabase_functions.http_request') IS NULL THEN
    RAISE NOTICE 'No Supabase Database Webhook support here; nothing to repair.';
    RETURN;
  END IF;

  -- Take the endpoint and the secret from a live webhook rather than inventing them.
  SELECT (regexp_match(pg_get_triggerdef(t.oid), '(https://[^'']+)'))[1],
         (regexp_match(pg_get_triggerdef(t.oid), 'Bearer ([A-Za-z0-9_.-]+)'))[1]
    INTO v_url, v_secret
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal
    AND p.proname = 'http_request'
    AND pg_get_triggerdef(t.oid) LIKE '%/functions/v1/send-push%'
    AND pg_get_triggerdef(t.oid) LIKE '%Bearer %'
  ORDER BY t.tgname
  LIMIT 1;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'No send-push webhook found to copy the endpoint and secret from. '
                 'Create the webhooks in Dashboard -> Database -> Webhooks first '
                 '(README, "Turning it on"), then run this migration again.';
    RETURN;
  END IF;

  -- Every existing webhook must already agree on one secret. If they do not, this is a
  -- half-finished rotation and silently picking one would send pushes that 401 in the
  -- dark, so stop and let a person decide.
  SELECT count(*), count(DISTINCT (regexp_match(pg_get_triggerdef(t.oid), 'Bearer ([A-Za-z0-9_.-]+)'))[1])
    INTO v_sources, v_distinct
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal
    AND p.proname = 'http_request'
    AND pg_get_triggerdef(t.oid) LIKE '%/functions/v1/send-push%'
    AND pg_get_triggerdef(t.oid) LIKE '%Bearer %';

  IF v_distinct <> 1 THEN
    RAISE EXCEPTION 'The live send-push webhooks use % different secrets (PUSH_WEBHOOK_SECRET '
                    'was probably rotated on some but not all of them). Fix them in Database -> '
                    'Webhooks, then run this migration again.', v_distinct;
  END IF;

  -- Same header spelling the dashboard writes, so all the webhooks look alike.
  v_headers := jsonb_build_object(
    'Content-type', 'application/json',
    'Authorization', 'Bearer ' || v_secret
  );

  -- 1a. "I miss you", first tap of a batch: a new day's row.
  EXECUTE 'DROP TRIGGER IF EXISTS miss_you_taps_insert ON public.miss_you_taps';
  EXECUTE format(
    $sql$CREATE TRIGGER miss_you_taps_insert AFTER INSERT ON public.miss_you_taps
         FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(%L, 'POST', %L, '{}', '5000')$sql$,
    v_url, v_headers::text);

  -- 1b. "I miss you", first tap of a batch: fresh taps after the partner opened theirs.
  --      send-push compares old_record with record and stays silent unless this is the
  --      transition from nothing-waiting to something-waiting, so tapping freely is not
  --      tapping your partner's phone to death.
  EXECUTE 'DROP TRIGGER IF EXISTS miss_you_taps_update ON public.miss_you_taps';
  EXECUTE format(
    $sql$CREATE TRIGGER miss_you_taps_update AFTER UPDATE ON public.miss_you_taps
         FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(%L, 'POST', %L, '{}', '5000')$sql$,
    v_url, v_headers::text);

  -- 2a. The letters' knock: only the moment sealed_at goes from NULL to set. A dashboard
  --     webhook on epistles would also fire on every draft autosave, which is why this one
  --     is a trigger and not a row in Database -> Webhooks.
  EXECUTE 'DROP TRIGGER IF EXISTS epistles_sealed ON public.epistles';
  EXECUTE format(
    $sql$CREATE TRIGGER epistles_sealed AFTER UPDATE ON public.epistles
         FOR EACH ROW WHEN (new.sealed_at IS NOT NULL AND old.sealed_at IS NULL)
         EXECUTE FUNCTION supabase_functions.http_request(%L, 'POST', %L, '{}', '5000')$sql$,
    v_url, v_headers::text);

  -- 2b. A letter born sealed still knocks. A draft insert has sealed_at NULL and never
  --     reaches the trigger at all.
  EXECUTE 'DROP TRIGGER IF EXISTS epistles_sealed_on_insert ON public.epistles';
  EXECUTE format(
    $sql$CREATE TRIGGER epistles_sealed_on_insert AFTER INSERT ON public.epistles
         FOR EACH ROW WHEN (new.sealed_at IS NOT NULL)
         EXECUTE FUNCTION supabase_functions.http_request(%L, 'POST', %L, '{}', '5000')$sql$,
    v_url, v_headers::text);

  RAISE NOTICE 'send-push webhooks repaired: miss_you_taps INSERT + UPDATE, epistles INSERT.';
END
$fix_push_webhooks$;

COMMIT;

-- What "repaired" should look like afterwards — six triggers, one secret, one endpoint:
--
--   SELECT c.relname, t.tgname,
--          CASE WHEN pg_get_triggerdef(t.oid) ~ 'INSERT OR UPDATE' THEN 'INSERT+UPDATE'
--               WHEN pg_get_triggerdef(t.oid) ~ 'AFTER INSERT'  THEN 'INSERT'
--               ELSE 'UPDATE' END AS events
--   FROM pg_trigger t
--   JOIN pg_class c ON c.oid = t.tgrelid
--   JOIN pg_proc p  ON p.oid = t.tgfoid
--   WHERE NOT t.tgisinternal AND p.proname = 'http_request'
--   ORDER BY 1, 2;
--
--   answers          answers                    INSERT
--   epistles         epistles_sealed            UPDATE
--   epistles         epistles_sealed_on_insert  INSERT
--   game_matches     game                       UPDATE
--   messages         messages                   INSERT
--   miss_you_taps    miss_you_taps_insert       INSERT
--   miss_you_taps    miss_you_taps_update       UPDATE
