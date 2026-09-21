-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921100000 — Letting a joiner see the groups they may choose
--
-- 20260920140000 already built the hard part: `invite_links.allow_group_choice`
-- / `allow_multi_group`, `member_groups.pickable_at_join`, and
-- `app.redeem_invite_link` already validates a submitted group id against
-- exactly this set (community-scoped, pickable, not archived) before it is
-- honoured. What was missing is a way for the join PAGE to know which groups
-- those are, so it can offer them at all — `app.get_public_invite` returned
-- `preset_group_names` (the groups everyone lands in) but nothing about the
-- ones a joiner may pick.
--
-- `pickable_groups` is returned only when the link actually allows a choice.
-- A link with `allow_group_choice = false` gets an empty array — group names on
-- a link that never uses them is exposure this page has no reason to carry
-- (same instinct as `preset_group_names` only ever naming the linked groups).
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists app.get_public_invite(text);

create or replace function app.get_public_invite(p_token text)
returns table (
  community_name     text,
  community_logo_url text,
  label              text,
  approve_joiners    boolean,
  allow_group_choice boolean,
  allow_multi_group  boolean,
  preset_group_names text[],
  pickable_groups    jsonb,
  fields             jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_link public.invite_links%rowtype;
begin
  select * into v_link
  from public.invite_links
  where token_prefix = left(p_token, 12)
  limit 1;

  if v_link.id is null
     or v_link.token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex')
     or v_link.status <> 'active'
     or (v_link.expires_at is not null and v_link.expires_at <= now())
     or (v_link.max_uses is not null and v_link.uses >= v_link.max_uses) then
    return;
  end if;

  return query
  select
    c.name,
    c.logo_url,
    v_link.label,
    v_link.approve_joiners,
    v_link.allow_group_choice,
    v_link.allow_multi_group,
    coalesce(
      (select array_agg(g.name order by g.sort_order)
       from public.member_groups g
       where g.id = any (v_link.group_ids)),
      '{}'
    ),
    case
      when v_link.allow_group_choice then
        coalesce(
          (select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.sort_order)
           from public.member_groups g
           where g.community_id = v_link.community_id
             and g.pickable_at_join
             and g.archived_at is null),
          '[]'::jsonb
        )
      else '[]'::jsonb
    end,
    coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'key', d.key,
                  'label', d.label,
                  'type', d.type,
                  'options', d.options,
                  'required', d.key = any (v_link.required_attribute_keys)
                )
                order by d.sort_order
              )
       from public.member_attribute_definitions d
       where d.community_id = v_link.community_id
         and d.key = any (v_link.asked_attribute_keys)),
      '[]'::jsonb
    )
  from public.communities c
  where c.id = v_link.community_id
    and c.status = 'active';
end;
$$;

comment on function app.get_public_invite(text) is
  'SEC-12-style whitelist for the join page: the community, the groups the joiner lands in automatically, the groups they may additionally choose from (only when the link allows it), and the fields to ask. Never member data, never the token, never how the link has been used.';

revoke execute on function app.get_public_invite(text) from public;
grant  execute on function app.get_public_invite(text) to anon, authenticated;
