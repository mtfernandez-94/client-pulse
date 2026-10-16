-- Remove the review feature's stored data from Client Pulse.
-- Run in the Supabase SQL editor against the Client Pulse project.
--
-- ORDER MATTERS: deploy the app version without reviews FIRST (git push → Pages,
-- ~1 min), then run this. The old app writes a `reviews` field on every save,
-- so dropping the column while the old app is live would make saves fail.
--
-- Irreversible: review dates/completions/notes are deleted. Review notes that
-- were also copied into client_notes ("**Review N completed**") are kept.

alter table public.clients drop column if exists reviews;
