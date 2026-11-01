-- Placing several crew cards in one call (place_crew_cards).
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ana@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ben@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'cleo@test.local');

create temp table ids (k text primary key, v text);
grant all on ids to authenticated, anon;
create temp table defaults as select '[
  {"name": "Unsorted", "stage": null}, {"name": "Creation", "stage": "creation"}, {"name": "Production", "stage": "production"},
  {"name": "Prep", "stage": "prep"}, {"name": "Release", "stage": "release"}, {"name": "Promotion", "stage": "promotion"}
]'::jsonb as v;
grant all on defaults to authenticated, anon;

set local role authenticated;

-- Cleo's crew, with a production song of hers.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
insert into ids values ('other', public.create_crew('Other', 'Cleo')::text);
insert into public.songs (id, crew_id, title, stage) values ('5c000000-0000-0000-0000-000000000001', (select v::uuid from ids where k = 'other'), 'Her Song', 'production');

-- Ana's crew: columns, two production songs and one in prep; Ben joins.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
insert into ids values ('crew', public.create_crew('Crew', 'Ana')::text);
insert into ids values ('code', public.create_invite((select v::uuid from ids where k = 'crew'), 5));
create temp table cols as select * from public.set_crew_columns((select v::uuid from ids where k = 'crew'), (select v from defaults));
grant all on cols to authenticated, anon;
insert into public.songs (id, crew_id, title, stage) values
  ('5a000000-0000-0000-0000-000000000001', (select v::uuid from ids where k = 'crew'), 'One', 'production'),
  ('5a000000-0000-0000-0000-000000000002', (select v::uuid from ids where k = 'crew'), 'Two', 'production'),
  ('5a000000-0000-0000-0000-000000000003', (select v::uuid from ids where k = 'crew'), 'Three', 'prep');
reset role;
update public.songs set stage_updated_at = now() - interval '1 hour';
insert into ids select 'v-' || id::text, stage_updated_at::text from public.songs;
set local role authenticated;

select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select public.join_crew((select v from ids where k = 'code'), 'Ben');

-- A member places two cards of a song they don't own in one call.
create temp table placed as select * from public.place_crew_cards(
  (select id from cols where stage = 'production'),
  '[{"id": "5a000000-0000-0000-0000-000000000002", "order": 1}, {"id": "5a000000-0000-0000-0000-000000000001", "order": 2}]'::jsonb);
grant all on placed to authenticated, anon;
select is((select count(*) from placed)::int, 2, 'a member places several cards in one call');
select is((select array_agg(title order by board_order) from public.songs where column_id = (select id from cols where stage = 'production')),
  array['Two', 'One'], 'the column shows the new order');
select is((select count(*) from public.songs where stage_updated_at::text <> (select v from ids where k = 'v-' || songs.id::text))::int, 0, 'stage versions never change');

-- A card of another stage is left alone (a stage change needs a version).
select is((select count(*) from public.place_crew_cards((select id from cols where stage = 'production'),
  '[{"id": "5a000000-0000-0000-0000-000000000003", "order": 1}]'::jsonb))::int, 0, 'a card of another stage is not placed');
select is((select stage from public.songs where id = '5a000000-0000-0000-0000-000000000003'), 'prep', 'and its stage stays');

-- Another crew's song is never touched (even when listed).
select is((select count(*) from public.place_crew_cards((select id from cols where stage = 'production'),
  '[{"id": "5c000000-0000-0000-0000-000000000001", "order": 1}]'::jsonb))::int, 0, 'another crew''s song is not placed');

-- Refusals.
select throws_ok($$ select public.place_crew_cards((select id from cols where stage = 'production'), '[]'::jsonb) $$,
  '22023', null, 'an empty list is refused');
select throws_ok($$ select public.place_crew_cards((select id from cols where stage = 'production'),
  '[{"id": "5a000000-0000-0000-0000-000000000001", "order": 1}, {"id": "5a000000-0000-0000-0000-000000000001", "order": 2}]'::jsonb) $$,
  '22023', null, 'a card listed twice is refused');
select throws_ok($$ select public.place_crew_cards((select id from cols where stage = 'production'),
  '[{"id": "5a000000-0000-0000-0000-000000000001", "order": "NaN"}]'::jsonb) $$,
  '22023', 'bad card order', 'a non-number order is refused');
select throws_ok($$ select public.place_crew_cards((select id from cols where stage = 'production'),
  '[{"id": "nope", "order": 1}]'::jsonb) $$,
  '22023', 'bad card id', 'a bad id is refused');

-- An outsider can't use the crew's columns.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.place_crew_cards((select id from cols where stage = 'production'),
  '[{"id": "5a000000-0000-0000-0000-000000000001", "order": 9}]'::jsonb) $$,
  '22023', 'column not in this crew', 'an outsider cannot place cards');
reset role;
select is((select board_order from public.songs where id = '5a000000-0000-0000-0000-000000000001'), 2::double precision, 'the outsider changed nothing');
select ok(not has_function_privilege('anon', 'public.place_crew_cards(uuid, jsonb)', 'execute'), 'anonymous visitors cannot call it');

select * from finish();
rollback;
