-- Read-only inventory of the ledger rows eligible at the fixed cutoff instant. Addresses are stored as SHA-256 and domain only.
begin transaction isolation level repeatable read read only;
copy (
with p as (
 select a.id, a.community_id, a.delivery_id, e.id event_id, c.slug, e.event_key, e.event_type, a.attempted_at, a.send_class,
  substring(a.address_key from '@(.*)$') address_domain,
  encode(sha256(convert_to(a.address_key,'UTF8')),'hex') address_sha256,
  d.status::text delivery_status,
  substring(c.slug from '^itest-([0-9a-f]{8})-[0-9]+$') stag,
  substring(a.address_key from '^itest\+([0-9a-f]{8})-[0-9]+@[a-z0-9-]+\.example\.test$') atag,
  substring(a.address_key from '^itest\+[0-9a-f]{8}-[0-9]+@([a-z0-9-]+)\.example\.test$') alabel,
  substring(e.event_key from '^itest-([0-9a-f]{8})-[a-z0-9-]+-[0-9]+$') etag,
  substring(e.event_key from '^itest-[0-9a-f]{8}-([a-z0-9-]+)-[0-9]+$') elabel,
  d.id did, d.community_id dc, d.recipient_address ra, a.address_key ak, d.channel::text ch, d.send_lease_token lt, d.send_class dsc, d.recipient_user_id ru, d.recipient_member_id rm,
  e.community_id ec, c.contact_email ce, c.contact_phone_e164 cp, c.is_personal ip,
  au.email auemail, au.phone auphone, cu.email cuemail, cu.phone cuphone,
  (select count(*) from public.members m where m.community_id=a.community_id) members
 from public.notification_send_attempts a
 left join public.communities c on c.id=a.community_id
 left join public.notification_deliveries d on d.id=a.delivery_id
 left join public.notification_events e on e.id=d.notification_event_id
 left join auth.users au on au.id=e.actor_user_id
 left join auth.users cu on cu.id=c.created_by
 where a.attempted_at < timestamptz '2026-11-06 16:23:52+00' - interval '48 hours'
)
select id, community_id, slug community_slug, delivery_id, event_id, event_key, event_type,
 to_char(attempted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') attempted_at_utc,
 to_char((attempted_at + interval '48 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') eligible_from_utc,
 send_class, address_domain, address_sha256, delivery_status,
 (stag is not null) is true slug_strict,
 (atag is not null) is true address_strict,
 (stag=atag and stag=etag and alabel=elabel) is true tags_agree,
 (did is not null and dc=community_id and lower(ra)=ak and ch='email' and delivery_status in ('sent','dead') and lt is null and dsc=send_class) is true delivery_test_only,
 (event_id is not null and ec=community_id and etag is not null) is true event_test_only,
 (ru is null and rm is null) is true no_linked_recipient,
 (ce is null and cp is null and ip=false and members=0) is true no_contact_or_member,
 (auemail ~ '^itest\+[0-9a-f]{8}-[0-9]+@[a-z0-9-]+\.example\.test$' and auphone is null and cuemail ~ '^itest\+[0-9a-f]{8}-[0-9]+@[a-z0-9-]+\.example\.test$' and cuphone is null) is true actor_creator_test
from p order by id
) to stdout with (format csv, header true);
rollback;
