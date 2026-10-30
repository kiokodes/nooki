-- Older children can encounter fuller scenes; younger scenes stay short.
BEGIN;
ALTER TABLE public.event_templates DROP CONSTRAINT IF EXISTS event_templates_setup_text_check;
ALTER TABLE public.event_templates ADD CONSTRAINT event_templates_setup_text_check
  CHECK (char_length(btrim(setup_text)) BETWEEN 1 AND CASE WHEN min_age >= 10 THEN 480 ELSE 220 END);
COMMIT;
