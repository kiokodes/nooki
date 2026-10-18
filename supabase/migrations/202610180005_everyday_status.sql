-- Private, current-only snapshots. No mood history and no push notifications.
BEGIN;
CREATE TABLE IF NOT EXISTS public.everyday_status (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  couple_id uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  mood text CHECK (mood IN ('Happy','Calm','Tired','Stressed','Sad','Missing you')),
  activity text CHECK (activity IN ('Working','Studying','Resting','Out and about','Free to talk')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 120),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  CHECK (mood IS NOT NULL OR activity IS NOT NULL OR btrim(note) <> '')
);
ALTER TABLE public.everyday_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS everyday_status_read ON public.everyday_status;
CREATE POLICY everyday_status_read ON public.everyday_status FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND expires_at > now());
REVOKE ALL ON public.everyday_status FROM anon, authenticated;
GRANT SELECT ON public.everyday_status TO authenticated;

CREATE OR REPLACE FUNCTION public.save_everyday_status(p_mood text, p_activity text, p_note text, p_hours integer DEFAULT 12)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid;
BEGIN
  cid := public.get_user_couple_id(auth.uid());
  IF auth.uid() IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner first.'; END IF;
  IF p_hours IS NULL OR p_hours NOT IN (1,4,12) THEN RAISE EXCEPTION 'Choose 1, 4 or 12 hours.'; END IF;
  INSERT INTO public.everyday_status(user_id,couple_id,mood,activity,note,updated_at,expires_at)
  VALUES(auth.uid(),cid,p_mood,p_activity,btrim(coalesce(p_note,'')),clock_timestamp(),now()+make_interval(hours => p_hours))
  ON CONFLICT(user_id) DO UPDATE SET couple_id=excluded.couple_id,mood=excluded.mood,
    activity=excluded.activity,note=excluded.note,updated_at=excluded.updated_at,
    expires_at=excluded.expires_at,acknowledged_at=NULL;
END; $$;
CREATE OR REPLACE FUNCTION public.clear_everyday_status()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.everyday_status WHERE user_id=auth.uid();
$$;
CREATE OR REPLACE FUNCTION public.acknowledge_everyday_status(p_user_id uuid, p_updated_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.everyday_status SET acknowledged_at=now()
  WHERE user_id=p_user_id AND user_id<>auth.uid()
    AND couple_id=public.get_user_couple_id(auth.uid())
    AND updated_at=p_updated_at AND expires_at>now() AND acknowledged_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'This update has changed or is no longer available.'; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.save_everyday_status(text,text,text,integer), public.clear_everyday_status(), public.acknowledge_everyday_status(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_everyday_status(text,text,text,integer), public.clear_everyday_status(), public.acknowledge_everyday_status(uuid,timestamptz) TO authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS
    (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='everyday_status') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.everyday_status;
  END IF;
END $$;
COMMIT;
