alter table public.memberships
  add column if not exists username text;

create unique index if not exists memberships_username_unique_idx
  on public.memberships (lower(username))
  where username is not null;

do $$
declare
  row record;
  base_username text;
  candidate_username text;
  suffix integer;
begin
  for row in
    select user_id, full_name
    from public.memberships
    where username is null
      and role::text in ('driver', 'autista')
    order by created_at nulls first, user_id
  loop
    base_username := lower(trim(regexp_replace(coalesce(row.full_name, 'autista'), '[^a-zA-Z0-9]+', '.', 'g')));
    base_username := regexp_replace(base_username, '(^\.+|\.+$)', '', 'g');
    if base_username = '' then
      base_username := 'autista';
    end if;

    candidate_username := base_username;
    suffix := 2;
    while exists (
      select 1
      from public.memberships
      where lower(username) = lower(candidate_username)
        and user_id <> row.user_id
    ) loop
      candidate_username := base_username || suffix::text;
      suffix := suffix + 1;
    end loop;

    update public.memberships
    set username = candidate_username
    where user_id = row.user_id;
  end loop;
end $$;
