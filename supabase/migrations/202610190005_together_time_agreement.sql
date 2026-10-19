-- Together time: a shared date is a suggestion until both partners agree to it.
--
-- One partner used to be able to schedule a book or game at a fixed time on the
-- other's behalf, reminder and all. Now a new Together time starts life as
-- 'proposed': it locks in ('scheduled', with the due-time reminder) only when the
-- partner who did not suggest it agrees. Either partner can counter-suggest a
-- different time instead, which hands the suggestion back the other way, and
-- moving a locked-in time turns it back into a suggestion the same way.
--
-- Additive migration: dates already scheduled under the old rules stay scheduled.
BEGIN;

ALTER TABLE public.together_time_sessions
  ADD COLUMN IF NOT EXISTS proposed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agreed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agreed_at TIMESTAMPTZ;

-- Existing rows were made by their creator; already-scheduled dates keep their
-- status (and their reminder), only new suggestions wait for an agreement.
UPDATE public.together_time_sessions
SET proposed_by = created_by
WHERE proposed_by IS NULL;

ALTER TABLE public.together_time_sessions
  DROP CONSTRAINT IF EXISTS together_time_sessions_status_check;
ALTER TABLE public.together_time_sessions
  ADD CONSTRAINT together_time_sessions_status_check
  CHECK (status IN ('proposed', 'scheduled', 'done', 'cancelled'));
ALTER TABLE public.together_time_sessions
  ALTER COLUMN status SET DEFAULT 'proposed';

-- The agreement rules live in the guard trigger, so no client can skip them:
-- a partner can only ever create a suggestion, only the other partner can agree
-- to it (and only to the exact time and activity suggested), and changing the
-- time or activity always makes it a fresh suggestion from the changer. The
-- trigger stamps proposed_by/agreed_by/agreed_at itself; values sent by a client
-- for those columns are never trusted. The reminder service runs without an
-- auth user and is exempt, exactly as before.
CREATE OR REPLACE FUNCTION public.guard_together_time_session()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  plan_changed BOOLEAN;
BEGIN
  IF NEW.activity_type = 'game' AND NEW.activity_id NOT IN (
    'rock-paper-scissors', 'snake', 'chess', 'sudoku', 'tetris',
    'connect-four', 'dash-duel', 'word-wheel'
  ) THEN
    RAISE EXCEPTION 'Choose one of the games in Nooki.';
  END IF;
  IF NEW.activity_type = 'book' AND NOT EXISTS (
    SELECT 1 FROM public.shared_books
    WHERE id::text = NEW.activity_id AND couple_id = NEW.couple_id
  ) THEN
    RAISE EXCEPTION 'Choose a book from your shared shelf.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF actor IS NOT NULL THEN
      IF NEW.status <> 'proposed' THEN
        RAISE EXCEPTION 'A Together time starts as a suggestion. It locks in when your partner agrees.';
      END IF;
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF NEW.proposed_by IS NULL THEN
      NEW.proposed_by := NEW.created_by;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.couple_id <> OLD.couple_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A scheduled date stays with the couple who made it.';
  END IF;
  IF actor IS NOT NULL
     AND NEW.reminder_sent_at IS DISTINCT FROM OLD.reminder_sent_at THEN
    RAISE EXCEPTION 'Only the reminder service can change reminder status.';
  END IF;

  IF actor IS NOT NULL THEN
    plan_changed := NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
      OR NEW.timezone IS DISTINCT FROM OLD.timezone
      OR NEW.activity_type IS DISTINCT FROM OLD.activity_type
      OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
      OR NEW.activity_name IS DISTINCT FROM OLD.activity_name;

    IF OLD.status IN ('done', 'cancelled') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'That Together time is over. Suggest a new one instead.';
    END IF;
    IF OLD.status = 'proposed' AND NEW.status = 'done' THEN
      RAISE EXCEPTION 'Agree on a time together before marking it done.';
    END IF;

    IF OLD.status = 'proposed' AND NEW.status = 'scheduled' THEN
      IF actor IS NOT DISTINCT FROM OLD.proposed_by THEN
        RAISE EXCEPTION 'Your partner needs to agree before this locks in.';
      END IF;
      IF plan_changed THEN
        RAISE EXCEPTION 'Agree to the suggested time as it is, or suggest a different one.';
      END IF;
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := actor;
      NEW.agreed_at := now();
    ELSIF NEW.status = 'proposed' AND (OLD.status = 'scheduled' OR plan_changed) THEN
      -- Whoever just (re)suggested now waits for the other partner to agree.
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF OLD.status = 'scheduled' AND NEW.status = 'scheduled' AND plan_changed THEN
      RAISE EXCEPTION 'This time is locked in. Suggest a different time and let your partner agree.';
    ELSE
      -- Done/cancelled and no-op updates keep the agreement record as it was.
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := OLD.agreed_by;
      NEW.agreed_at := OLD.agreed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_together_time_session ON public.together_time_sessions;
CREATE TRIGGER guard_together_time_session
BEFORE INSERT OR UPDATE ON public.together_time_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_together_time_session();

COMMIT;
