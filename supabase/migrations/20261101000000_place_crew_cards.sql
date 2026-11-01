-- Placing several crew cards in one call (review 2026-11, §3 Crew).
-- Dropping a card among cards nobody placed by hand means placing the whole
-- column as it's shown. Until now that was one move_crew_card call per card
-- (a 40-card column: 40 requests). place_crew_cards sets the column and
-- order of many cards at once.
--
-- It only reorders inside one stage: a card of another stage than the
-- column's is left alone (changing a stage needs the version check of
-- move_crew_card / move_song_stage). Any crew member may call it, like
-- move_crew_card; the stage stamps never change.

create function public.place_crew_cards(p_column uuid, p_cards jsonb)
returns table (id uuid, column_id uuid, board_order double precision)
language plpgsql security definer set search_path = ''
as $$
declare
  v_crew uuid;
  v_stage text;
  v_item jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select c.crew_id, c.stage into v_crew, v_stage from public.crew_columns c where c.id = p_column;
  if not found or not public.is_crew_member(v_crew) then
    raise exception 'column not in this crew' using errcode = '22023';
  end if;
  if p_cards is null or jsonb_typeof(p_cards) <> 'array'
     or jsonb_array_length(p_cards) not between 1 and 500 then
    raise exception 'cards must be a list of 1 to 500' using errcode = '22023';
  end if;

  -- Validate everything before writing anything.
  for v_item in select e.value from jsonb_array_elements(p_cards) as e loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'order') is distinct from 'number' then
      raise exception 'bad card order' using errcode = '22023';
    end if;
    begin
      v_id := (v_item ->> 'id')::uuid;
    exception when others then
      raise exception 'bad card id' using errcode = '22023';
    end;
    if v_id is null or v_id = any (v_ids) then
      raise exception 'bad card id' using errcode = '22023';
    end if;
    v_ids := v_ids || v_id;
  end loop;

  return query
    update public.songs s
      set column_id = p_column, board_order = (x.value ->> 'order')::double precision
      from jsonb_array_elements(p_cards) as x
      where s.id = (x.value ->> 'id')::uuid
        and s.crew_id = v_crew
        and s.stage is not distinct from v_stage
      returning s.id, s.column_id, s.board_order;
end;
$$;

revoke execute on function public.place_crew_cards(uuid, jsonb) from public, anon;
grant execute on function public.place_crew_cards(uuid, jsonb) to authenticated;
