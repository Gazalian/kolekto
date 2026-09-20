# 0014 — A contributor identifies themselves inside one collection, and is never a user

**Status:** Accepted · 2026-09-20

## Context

A managed collection asks named people for money: class dues, an estate
service charge, an association levy. The contributor who opens its link has no
Kolekto account and should not need one (PRD 0.3, SEC-06). Before the page can
say what they owe, it has to work out which member of that community they are.

That is a search over a community's roll, exposed to `anon` — the most
sensitive surface the product has built so far. A community's membership list
is not public information: it says who belongs to a church, who lives in an
estate, who is in a class.

Three shapes were available:

1. **Make the contributor log in.** Send an OTP, create an auth user, let them
   pick their member record.
2. **Give every member a private link.** A token per member (OBL-12 already
   reserves `link_token_hash` on `obligations`), distributed by the community.
3. **Let them find themselves, scoped to the collection.** One search box,
   matching only things the person already knows, over only the members that
   collection is for.

## Decision

**Option 3, with option 2 left open for Phase 4.**

`app.find_collection_member(collection_id, query)` searches the audience of one
collection. Its candidate set is `app.resolve_collection_audience`, which
already excludes archived and merged members and already applies group and
selected-member rules — so identification cannot disagree with who the
collection is for.

The rules that make it safe to expose:

- **Equality, not browsing.** A match is an exact member code, an exact value
  of an attribute the community declared unique, an exact phone or email. There
  is no prefix search and no wildcard.
- **A name needs two parts.** One name part finds nobody: "grace" would
  otherwise return a congregation.
- **Ambiguity returns a number.** Several matches yield a count and the label of
  the field that would tell them apart — no ids, no names, no identifiers.
  Disambiguation is the contributor typing something more specific.
- **Minimum information.** A single match returns that person's name, member
  code and the community's primary identifier. Not their phone, not their
  email, not any other attribute, not their status.
- **No reason is ever given.** A draft collection, an open collection, an
  archived member and a member of another community all answer exactly as an
  empty search does. A refusal that names its reason is a fact about somebody
  else.

Option 1 was rejected because it turns every payer into an account. The
previous system's contributors were not users and did not want to be; requiring
a login to pay dues is how a collection stops being collected.

Option 2 was not rejected — it is better for a personal reminder, and the
column for it exists. It is not sufficient on its own: a member who lost the
message still has to be able to pay from the community's public link, and a
per-member token cannot be shared in a group chat, which is how these links
actually travel.

## Consequences

**The identification is remembered server-side.** A signed, httpOnly cookie
holds `{collection_id, member_id}` for an hour. The browser cannot read it and
cannot write it — a member id in a form field is a member id a page can change,
and changing it means becoming somebody else on the roll. Every read re-checks
the member against `app.get_collection_member_context`, so an identification
does not survive the member being archived or the collection closing.

**Three identities stay distinct**, as they have since Phase 1: an
authenticated Kolekto user (an officer), a community member (a row on a roll,
which may never log in), and an anonymous contributor (a person with a link).
M7 adds no path that converts one into another.

**The obligation is authoritative for what is owed.** Once a member is
identified, `resolveContributionAmount` prefers their own row over the
collection's headline amount, less any waiver — charging the headline would
charge them for a waiver an officer granted them.

**Abuse is only partly addressable here.** Equality matching means the roll
cannot be walked, but somebody holding a stolen list of identifiers could
confirm which of them are in a collection. The application throttles lookups
per process; real rate limiting belongs at the edge, and that is where it goes
when this is deployed. This is stated rather than implied because the honest
description of an in-memory counter is that it is a brake, not a lock.
