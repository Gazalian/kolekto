# Legacy identity inventory

**Source:** `busfgcmbndleljklrcbd`, verified 2026-09-26
**No password hash, token, session or credential was read or exported.** Every
figure is an aggregate.

---

## 1. Totals

| Figure | Value |
|---|---|
| `auth.users` | **623** |
| soft-deleted | 0 |
| with email | **623 (100%)** |
| **with phone** | **0** |
| email confirmed | 426 (68%) |
| phone confirmed | 0 |
| `auth.identities` | 623 |
| `profiles` | 622 |
| profiles with no auth user | **0** |
| auth users with no profile | **1** |
| `profiles.phone_number` present | **609** |
| `profiles.phone_number` absent | **13** |

---

## 2. F-M1: where the phone numbers actually are

**The founder requirement is "we need the phone number of all authenticated
users". The important discovery is that `auth.users.phone` is empty for all 623
rows.** Legacy never used Supabase's phone field; authentication is email-based
(623 email identities, 0 phone confirmations).

Phone numbers live in **`profiles.phone_number`**, a nullable `text`, and **609 of
622 profiles have one.**

So F-M1's remediation set is **13 profiles**, not 623. That is a tractable number:
a manual follow-up, an in-app prompt, or an accepted gap.

**Per F-M1, no phone number is invented and no account is deleted.** All 13 are
preserved.

### The constraint interaction, which is the real consequence

The new schema has `members_active_has_phone`:
`check (status <> 'active' or phone_e164 is not null)`.

A migrated person with no phone therefore **cannot be an `active` member.** For a
historical contributor that is correct and useful — they become `unclaimed`, on the
roll and claimable later. For these 13 *authenticated users*, the migration has to
choose a status. Options:

| Option | Consequence |
|---|---|
| Import as `unclaimed` until they supply a phone | Honest; they appear on the roll but not as active members. **Recommended.** |
| Import as `pending_approval` | Also available; implies an approval step that does not exist for migrated users |
| Relax the constraint for imported rows | Weakens a rule that exists to guarantee a verified contact. **Not recommended.** |

**This remains founder decision F-M1.** The 13 users are preserved either way; only
their roll status is open.

### Format quality

| Check | Result |
|---|---|
| fewer than 10 digits | **0** |
| more than 13 digits | **15** |
| duplicate email addresses | **0** |

The 15 overlong numbers need normalisation to E.164. The new schema expects
`phone_e164`, and `app.normalise_phone` already exists to do it. **Normalisation
must be recorded as a transformation**, with the original retained in
`migration.legacy_profile.fields`, because changing a stored contact detail is a
change to someone's record.

---

## 3. Duplicate phone groups — 27 groups, 66 profiles

Matching on the last 10 digits:

| Figure | Value |
|---|---|
| duplicate phone groups | **27** |
| profiles inside them | **66** |
| largest single group | **8 profiles sharing one number** |

This is a known legacy category and it is real. Eight accounts sharing one phone is
most likely one person with several accounts, or a shared family or business
number — and the two cases need opposite handling.

**It matters because of the new schema**, which enforces
`members_community_identifier_key` — a member identifier unique within a community
— and treats a verified phone as a member's identity. Two members in one community
sharing a phone is not automatically refused, but it defeats the identity model's
purpose.

**No merging is proposed here.** Merging accounts is a decision about people's
records and their history; the new schema even has a `merged` member status and a
`merged_into_id` column for it, so the mechanism exists. What it needs is a ruling,
per group, and the 27 groups are small enough to review individually.

`E-ID-2`: the 27 groups go to a manual review queue. Nothing is merged
automatically.

---

## 4. The three-way distinction, and how legacy blurs it

The new architecture separates **auth user**, **member**, and
**contributor/participation**. Legacy has only the first and a payment record.

| Legacy concept | Where it lives | Count | → New |
|---|---|---|---|
| Authenticated user | `auth.users` + `profiles` | 623 / 622 | `auth.users` + `public.users`, **UUID preserved** |
| Organizer | `collections.user_id` | — | `officer_terms` role `owner`, `start_reason='migration'` |
| Contributor | `contributions` name/email/phone | **3,353 distinct emails** | `public.members`, status `unclaimed` |
| Member | **does not exist** | — | created by the migration |
| Contact record | `contributions.contributor_information` jsonb | 5,576 | `member_contacts` |

### Contributors are decisively not users

| Figure | Value |
|---|---|
| contributions with an email | **5,576 (100%)** |
| contributions with a phone | 4,378 (79%) |
| contributions with **neither** | **0** |
| distinct contributor emails | **3,353** |
| contributions whose email matches a profile | **388 (7%)** |

**Only 7% of contributions came from someone with a Kolekto account.** The other
93% are payment-only identities. This is the strongest evidence in the whole
baseline for the new architecture's decision to keep contributors out of
`auth.users`, and it means the migration must create roughly 3,353 `unclaimed`
member records — not 3,353 accounts.

**`is_organizer` is `false` on all 622 profiles**, despite 275 collections existing.
The flag was never maintained. Organizer status must be derived from
`collections.user_id`, not read from the profile.

---

## 5. Anomalies, consolidated

| # | Anomaly | Count | Handling |
|---|---|---|---|
| E-ID-1 | Auth user with no profile | 1 | Preserve as auth user + minimal `public.users`. Do not invent a name. |
| F-M1 | Profiles with no phone | 13 | Preserve. Roll status is a founder decision. |
| E-ID-2 | Duplicate phone groups | 27 groups / 66 profiles | Manual review. No automatic merge. |
| E-ID-3 | Overlong phone numbers | 15 | Normalise to E.164, retain the original |
| E-ID-4 | Unconfirmed emails | 197 | Preserve confirmation state; do not mark confirmed |
| E-ID-5 | `is_organizer` never maintained | 622 | Derive from collection ownership |
| E-ID-6 | `user_identity` NIN/BVN | 12 | **BLOCKED — legal.** See below. |

**E-ID-6 is the one that cannot be resolved by engineering.** `user_identity` holds
NIN and BVN ciphertext, hashes and last-4 digits — Nigerian national identity
numbers. The new architecture's `verification_records` is deliberately designed to
store *a provider's reference and result*, not raw identity data. Migrating
`user_identity` as-is would contradict that design; dropping it would lose
compliance evidence. Counsel must rule on whether this data may be migrated at
all, and the KYC tables (174 rows across 5 tables) sit behind the same question.
