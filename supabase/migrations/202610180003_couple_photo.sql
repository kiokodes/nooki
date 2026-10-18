-- Run this migration on existing Supabase projects before deploying the Home tab's
-- couple picture frame. It is additive and safe to rerun: nothing existing is
-- modified.
--
-- The same statements live at the end of supabase/schema.sql for brand-new projects.
--
-- What this adds:
--   1. couple_photo — exactly ONE framed picture per couple: the row points at the
--                     file in storage, and both partners' phones read it through
--                     RLS. Either partner may replace it; the row's couple never
--                     moves.
--   2. Realtime on the table, so the moment one partner frames a new picture the
--                     other partner's nook updates without a refresh.
--   3. A private storage bucket (couple-photos) with couple-scoped policies and a
--                     ~10 MB per-file cap, so a picture is never readable by anyone
--                     outside the couple and never shareable by link. The app
--                     resizes uploads to a 1600px JPEG before they leave the phone;
--                     pictures are opened only through short-lived signed URLs.
BEGIN;

-- ============================================================================
-- 1) couple_photo: the one picture standing in the nook.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.couple_photo (
  -- One row per couple, ever: the couple IS the key.
  couple_id UUID PRIMARY KEY REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Storage path, always photos/{couple_id}/{photo_id}.jpg so the RLS folder check
  -- can read the owning couple straight off the object name.
  file_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT couple_photo_file_path_length CHECK (char_length(btrim(file_path)) BETWEEN 1 AND 500),
  CONSTRAINT couple_photo_file_path_prefix CHECK (left(btrim(file_path), 7) = 'photos/')
);

ALTER TABLE public.couple_photo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Couple members can see their framed picture" ON public.couple_photo;
CREATE POLICY "Couple members can see their framed picture" ON public.couple_photo
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can frame a picture" ON public.couple_photo;
CREATE POLICY "Couple members can frame a picture" ON public.couple_photo
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND uploaded_by = auth.uid()
);

-- Either partner may replace the picture: the frame belongs to the couple.
DROP POLICY IF EXISTS "Couple members can replace their framed picture" ON public.couple_photo;
CREATE POLICY "Couple members can replace their framed picture" ON public.couple_photo
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND uploaded_by = auth.uid()
);

DROP POLICY IF EXISTS "Couple members can take their picture down" ON public.couple_photo;
CREATE POLICY "Couple members can take their picture down" ON public.couple_photo
FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- The couple a picture belongs to never moves, and the server stamps every replace.
CREATE OR REPLACE FUNCTION public.guard_couple_photo()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.couple_id <> OLD.couple_id THEN
    RAISE EXCEPTION 'A framed picture belongs to one couple. Replace the file, not the couple.';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS couple_photo_guard ON public.couple_photo;
CREATE TRIGGER couple_photo_guard
BEFORE UPDATE ON public.couple_photo
FOR EACH ROW EXECUTE FUNCTION public.guard_couple_photo();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.couple_photo TO authenticated;
REVOKE ALL ON public.couple_photo FROM anon;

-- ============================================================================
-- 2) Live updates: a picture framed on one phone appears on the other.
-- ============================================================================

ALTER TABLE public.couple_photo REPLICA IDENTITY FULL;

DO $realtime$
DECLARE
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'couple_photo'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.couple_photo';
  END IF;
END
$realtime$;

-- ============================================================================
-- 3) Storage: a private bucket for the picture itself.
--
-- The path is always photos/{couple_id}/{photo_id}.jpg, and the policies below read
-- the couple straight off that folder name: only the two partners can upload, read
-- (via signed URLs) or delete their own picture's file. The bucket is never public
-- and nothing here creates a shareable link.
--
-- The storage schema is absent on a bare database (and in the test backend), so every
-- statement is guarded and a rerun is always safe.
-- ============================================================================

DO $photo_storage$
DECLARE
  has_size_limit BOOLEAN;
  has_mime_types BOOLEAN;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('couple-photos', 'couple-photos', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  -- The app resizes to a 1600px JPEG (~a few hundred KB) before uploading; 10 MB is
  -- the hard ceiling for the rare original that could not be processed on the phone.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) INTO has_size_limit;
  IF has_size_limit THEN
    EXECUTE 'UPDATE storage.buckets SET file_size_limit = 10485760 WHERE id = ''couple-photos''';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) INTO has_mime_types;
  IF has_mime_types THEN
    EXECUTE $sql$UPDATE storage.buckets
      SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
      WHERE id = 'couple-photos'$sql$;
  END IF;

  -- Read (for signed URLs), upload and delete are all scoped to the couple's own
  -- folder: photos/{couple_id}/... — the folder name IS the couple id.
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can read their picture files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can read their picture files" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'couple-photos'
    AND (storage.foldername(name))[1] = 'photos'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can upload their picture files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can upload their picture files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'couple-photos'
    AND (storage.foldername(name))[1] = 'photos'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can delete their picture files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can delete their picture files" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'couple-photos'
    AND (storage.foldername(name))[1] = 'photos'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;
END
$photo_storage$;

COMMIT;
