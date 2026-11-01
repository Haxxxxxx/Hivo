-- Handing a crew over (review 2026-11, §3 Crew). "You already own 3 crews.
-- Hand one over" had no way to do it: the only handover was the owner
-- leaving (the longest-standing member takes over). Now the owner names the
-- next owner, who must already be a member, and becomes a plain member.
-- The new owner may own at most 3 crews, like create_crew.

create function public.transfer_crew_ownership(p_crew uuid, p_to uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_crew is null or not public.is_crew_owner(p_crew) then
    raise exception 'only the owner can hand the crew over' using errcode = '42501';
  end if;
  if p_to is null or p_to = v_uid then
    raise exception 'pick another member of the crew' using errcode = '22023';
  end if;
  -- One handover at a time per crew.
  perform 1 from public.crews where id = p_crew for update;
  if not exists (select 1 from public.crew_members where crew_id = p_crew and user_id = p_to) then
    raise exception 'pick another member of the crew' using errcode = '22023';
  end if;
  if (select count(*) from public.crew_members where user_id = p_to and role = 'owner') >= 3 then
    raise exception 'they already own 3 crews' using errcode = 'P0001';
  end if;
  update public.crew_members set role = 'owner' where crew_id = p_crew and user_id = p_to;
  update public.crew_members set role = 'member' where crew_id = p_crew and user_id = v_uid;
end;
$$;

revoke execute on function public.transfer_crew_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_crew_ownership(uuid, uuid) to authenticated;
