-- Rollback of `npm run itest:net-lockdown`, kolekto-itest ONLY. Prepared, NOT applied.
-- Restores the ACLs recorded in catalog-before.txt. Restoring them re-opens finding F-13.
-- Run as supabase_admin inside the test container. Sends no HTTP request.
begin;
grant usage on schema net to public, anon, authenticated, service_role;
grant all on net._http_response, net.http_request_queue to public;
grant all on sequence net.http_request_queue_id_seq to public;
-- Functions with a NULL proacl in catalog-before.txt (default PUBLIC execute).
grant execute on function net._await_response(bigint), net._encode_url_with_params_array(text, text[]),
  net._http_collect_response(bigint, boolean), net._urlencode_string(character varying), net.check_worker_is_up(),
  net.http_collect_response(bigint, boolean), net.http_delete(text, jsonb, jsonb, integer, jsonb),
  net.wait_until_running(), net.wake(), net.worker_restart() to public;
-- http_get and http_post had explicit grants and no PUBLIC entry.
grant execute on function net.http_get(text, jsonb, jsonb, integer), net.http_post(text, jsonb, jsonb, jsonb, integer)
  to anon, authenticated, service_role;
commit;
