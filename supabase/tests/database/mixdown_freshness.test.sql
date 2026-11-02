-- Mixdown freshness: nullable, owner-written, member-read, old clients unaffected.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select has_column('public', 'songs', 'mixdown_fresh', 'songs has mixdown_fresh');
select col_is_null('public', 'songs', 'mixdown_fresh', 'mixdown_fresh is nullable (older clients never send it)');

insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ana@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ben@test.local');

create temp table ids (k text primary key, v text);
grant all on ids to authenticated, anon;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
insert into ids values ('crew', public.create_crew('Crew', 'Ana')::text);
insert into ids values ('code', public.create_invite((select v::uuid from ids where k = 'crew'), 5));

-- An older client's insert, without the column: still works, freshness unknown.
insert into public.songs (id, crew_id, title, has_mixdown) values ('5a000000-0000-0000-0000-000000000001', (select v::uuid from ids where k = 'crew'), 'Old Client', true);
select is((select mixdown_fresh from public.songs where id = '5a000000-0000-0000-0000-000000000001'), null::boolean, 'a row from an older client has unknown freshness');

-- A newer client sends it, and the owner can update it.
insert into public.songs (id, crew_id, title, has_mixdown, mixdown_fresh) values ('5a000000-0000-0000-0000-000000000002', (select v::uuid from ids where k = 'crew'), 'New Client', true, true);
update public.songs set mixdown_fresh = false where id = '5a000000-0000-0000-0000-000000000002';
select is((select mixdown_fresh from public.songs where id = '5a000000-0000-0000-0000-000000000002'), false, 'the owner marks the mixdown stale');

-- An older client clearing has_mixdown without touching the column is not refused.
select lives_ok($$ update public.songs set has_mixdown = false where id = '5a000000-0000-0000-0000-000000000002' $$, 'clearing has_mixdown alone still works');

-- A member reads it but can't change someone else's row.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select public.join_crew((select v from ids where k = 'code'), 'Ben');
select is((select mixdown_fresh from public.songs where id = '5a000000-0000-0000-0000-000000000002'), false, 'a crewmate reads it');
update public.songs set mixdown_fresh = true where id = '5a000000-0000-0000-0000-000000000002';
select is((select mixdown_fresh from public.songs where id = '5a000000-0000-0000-0000-000000000002'), false, 'a crewmate cannot change it');

select * from finish();
rollback;
