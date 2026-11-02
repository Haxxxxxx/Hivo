-- Mixdown freshness on crew cards (crew review round 2). `has_mixdown`
-- said only "there is a render", even when the project was saved after it.
-- The owner's app now also sends whether the newest mixdown is at least as
-- new as the last save. Nullable on purpose: null means no mixdown, or a
-- row written by a Hivo from before this column (freshness unknown), so old
-- clients keep working and `has_mixdown` stays what they read. No CHECK
-- tying it to has_mixdown: an old client that clears has_mixdown never
-- touches this column, and a constraint would make its push fail. Clients
-- read "no mixdown" from has_mixdown first.
--
-- Same rules as the other song details: only the owner writes it (the
-- songs_update policy), every member reads it. No path, note or audio.

alter table public.songs
  add column mixdown_fresh boolean;

comment on column public.songs.mixdown_fresh is
  'Newest mixdown is at least as new as the last save; null = no mixdown or unknown (older client).';
