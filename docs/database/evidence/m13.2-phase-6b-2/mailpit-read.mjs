// Read-only GETs against the test stack's Mailpit API (127.0.0.1:55424). Nothing is deleted or marked.
const api = "http://127.0.0.1:55424/api/v1";
const to = process.argv[2];
const get = async (p) => {
  const r = await fetch(`${api}${p}`);
  if (r.status !== 200) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};
const info = await get("/info");
console.log("info", JSON.stringify({ Messages: info.Messages, Unread: info.Unread, SMTPAccepted: info.RuntimeStats?.SMTPAccepted, SMTPRejected: info.RuntimeStats?.SMTPRejected, MessagesDeleted: info.RuntimeStats?.MessagesDeleted }));
const all = await get("/messages?limit=50");
console.log("total", all.total, "count", all.count);
for (const m of all.messages) console.log("list", m.Created, m.To.map((a) => a.Address).join(","), "|", m.Subject, "|", m.MessageID);
const found = await get(`/search?query=${encodeURIComponent(`to:"${to}"`)}`);
console.log("search total", found.total, "matches", found.messages.length);
const id = found.messages[0].ID;
// Note: opening the full message via the API marks it read in Mailpit; the test already read it.
const full = await get(`/message/${encodeURIComponent(id)}`);
console.log("from", full.From?.Address, "to", JSON.stringify(full.To?.map((a) => a.Address)), "cc", JSON.stringify(full.Cc ?? []), "bcc", JSON.stringify(full.Bcc ?? []));
console.log("subject", full.Subject);
console.log("messageId", full.MessageID);
const headers = await get(`/message/${encodeURIComponent(id)}/headers`);
for (const k of Object.keys(headers).sort()) console.log("header", k, JSON.stringify(headers[k]));
console.log("text-----\n" + full.Text + "\n-----");
console.log("html-----\n" + full.HTML + "\n-----");
console.log("contains phone prefix +234:", (full.Text + full.HTML).includes("+234"));
