-- Handing a crew over (transfer_crew_ownership).
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ana@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ben@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'cleo@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'dan@test.local');

create temp table ids (k text primary key, v text);
grant all on ids to authenticated, anon;

set local role authenticated;

-- Dan already owns 3 crews.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
select public.create_crew('D1', 'Dan');
select public.create_crew('D2', 'Dan');
select public.create_crew('D3', 'Dan');

-- Ana's crew; Ben and Dan join. Cleo is an outsider.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
insert into ids values ('crew', public.create_crew('Crew', 'Ana')::text);
insert into ids values ('code', public.create_invite((select v::uuid from ids where k = 'crew'), 5));
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select public.join_crew((select v from ids where k = 'code'), 'Ben');
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
select public.join_crew((select v from ids where k = 'code'), 'Dan');

-- Refusals.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.transfer_crew_ownership((select v::uuid from ids where k = 'crew'), 'b0000000-0000-0000-0000-000000000002') $$,
  '42501', 'only the owner can hand the crew over', 'a member cannot take the crew');
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.transfer_crew_ownership((select v::uuid from ids where k = 'crew'), 'c0000000-0000-0000-0000-000000000003') $$,
  '22023', 'pick another member of the crew', 'the new owner must be a member');
select throws_ok($$ select public.transfer_crew_ownership((select v::uuid from ids where k = 'crew'), 'a0000000-0000-0000-0000-000000000001') $$,
  '22023', 'pick another member of the crew', 'not to yourself');
select throws_ok($$ select public.transfer_crew_ownership((select v::uuid from ids where k = 'crew'), 'd0000000-0000-0000-0000-000000000004') $$,
  'P0001', 'they already own 3 crews', 'someone who owns 3 crews cannot take a fourth');
select ok(not has_function_privilege('anon', 'public.transfer_crew_ownership(uuid, uuid)', 'execute'), 'anonymous visitors cannot call it');

-- The owner hands it to Ben.
select lives_ok($$ select public.transfer_crew_ownership((select v::uuid from ids where k = 'crew'), 'b0000000-0000-0000-0000-000000000002') $$, 'the owner hands the crew over');
select is((select role from public.crew_members where crew_id = (select v::uuid from ids where k = 'crew') and user_id = 'b0000000-0000-0000-0000-000000000002'), 'owner', 'Ben is the owner');
select is((select role from public.crew_members where crew_id = (select v::uuid from ids where k = 'crew') and user_id = 'a0000000-0000-0000-0000-000000000001'), 'member', 'Ana is a member');
select is((select count(*) from public.crew_members where crew_id = (select v::uuid from ids where k = 'crew') and role = 'owner')::int, 1, 'one owner');
select throws_ok($$ select public.transfer_crew_ownership((select v::uuid from ids where k = 'crew'), 'a0000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'the old owner cannot take it back');

select * from finish();
rollback;
