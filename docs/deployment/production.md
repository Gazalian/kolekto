# Deploying to production (AWS) — client-IP trust

> **Status: PENDING ARCHITECTURE CONFIRMATION.** Production will run on AWS
> (owner decision, 2026-11-26). Which AWS components sit in front of the web app
> has not been decided. **No production value for `KOLEKTO_CLIENT_IP_SOURCE` is
> approved.** Until one is, leave it unset: production then answers every
> membership-ID check with "temporarily unavailable" (fail closed) rather than
> trusting a header a caller can write.

This document covers one thing: how the web server learns the caller's IP for the
membership-ID rate limit, and what the infrastructure must guarantee for that to
be safe. Everything else about the production deployment is out of scope here.

## 1. What the application does

`apps/web/lib/client-ip.ts` is the only code that reads proxy headers. It uses the
source named by `KOLEKTO_CLIENT_IP_SOURCE` (validated by `loadClientIpSource` in
`packages/config`) and nothing else:

| Value | Reads | Allowed in production |
|---|---|---|
| `local` | rightmost `X-Forwarded-For` entry | **No** — refused outside `KOLEKTO_ENV=local` |
| `vercel` | `x-vercel-forwarded-for` (one address) | Accepted by the code, but not meaningful on AWS — do not use |
| `xff-hops:N` (N = 1–3) | the Nth `X-Forwarded-For` entry **from the right** | Yes, once the architecture is approved |

The resolved address is normalised (IPv4; IPv6 lowercased and keyed by its /64;
IPv4-mapped IPv6 treated as IPv4), turned into `ip4:<address>` or
`ip6-64:<prefix>::/64`, HMAC'd with the membership-ID key, and only the hash is
sent to `app.validate_membership_id`. The SQL limits are unchanged.

Fails closed (generic "temporarily unavailable", no database call, a
`client_ip.unresolved` log line with a reason code only) when: the variable is
unset or invalid, the header is missing, empty, malformed or longer than 2048
characters, the chain has fewer than N entries, or any of the N rightmost entries
is not a valid address. There is no shared "unknown" bucket and no fallback to
another header.

## 2. Why hop counting is only as safe as the origin restriction

AWS documents that X-Forwarded-For entries "can only be considered trustworthy if
added by systems that are properly secured within the network" (ALB
`x-forwarded-headers`). Both ALB (default `append` mode) and CloudFront **append**
the address they see to the right of whatever the caller sent. Counting N entries
from the right therefore lands on the client **only if every request passed
through exactly those N proxies**.

If an attacker can reach a later hop directly, the count is off by one and a value
the attacker wrote becomes "the client". Example with `xff-hops:2`
(CloudFront → ALB) and an ALB that is reachable from the internet:

```
attacker → ALB directly, sending  X-Forwarded-For: 4.4.4.4
ALB appends the attacker's IP  →  X-Forwarded-For: 4.4.4.4, <attacker>
xff-hops:2 picks               →  4.4.4.4   (forged; a new value per request = a new bucket)
```

The application cannot detect this (the test
`DIRECT-ORIGIN BYPASS is an infrastructure property` in
`apps/web/lib/client-ip.test.ts` records it). **The origin restriction is part of
the security fix, not an optional hardening.**

## 3. Candidate architectures

| Architecture | What reaches the app | Value | Mandatory restriction |
|---|---|---|---|
| **CloudFront → internal ALB → ECS/EC2** (recommended) | `…caller entries, viewer, CloudFront edge` | `xff-hops:2` | ALB is internal, reached only via a CloudFront **VPC origin**; app targets accept traffic only from the ALB security group |
| CloudFront → internet-facing ALB → ECS/EC2 | same | `xff-hops:2` | ALB security group limited to the AWS-managed CloudFront prefix list **and** a listener rule requiring a secret origin header (403 otherwise); app accepts only from the ALB |
| ALB → ECS/EC2 (no CloudFront) | `…caller entries, client` | `xff-hops:1` | app targets accept traffic only from the ALB security group; nothing else in front |
| NLB → app | no HTTP header (socket address or Proxy Protocol v2) | **unsupported** | Next.js server actions cannot read the socket. Would need a reverse proxy that sets a header from the socket, plus its own restriction — a separate design |
| Amplify Hosting / Lambda (OpenNext) | not documented by AWS for client IP | **unsupported until verified** | — |
| API Gateway in front | not assessed | **unsupported** | — |

ALB settings the resolver assumes: `routing.http.xff_header_processing.mode` =
`append` (the default; `preserve` would pass the caller's header through
unchanged and `remove` would drop it — both fail or mislead). Optional client-port
preservation (`routing.http.xff_client_port.enabled`) is fine: ports and
`[IPv6]:port` forms are parsed.

## 4. Decision required from the owner

1. The components in front of the web app, in order (for example: CloudFront →
   internal ALB → ECS).
2. How direct access to every hop after the first is blocked (VPC origin /
   internal ALB, or prefix list + secret header, plus target security groups).
3. The ALB XFF mode (expected: `append`).

From those three answers the value follows (`xff-hops:2` for CloudFront → ALB,
`xff-hops:1` for ALB alone). It is set only after §5 passes.

## 5. Verification gate before enabling (production-like environment)

Do this on the real AWS path, before production traffic, with wrong IDs only:

1. Through the public URL, send three membership-ID attempts with different forged
   `X-Forwarded-For` / `X-Real-IP` values from one machine. In the database
   (read-only): `count(distinct ip_hash)` for those attempts = **1**.
2. From a second network: a **different** hash.
3. **Direct-origin test:** try to reach the ALB (and, if public, the targets)
   without CloudFront — by its DNS name or IP, with and without a forged
   `X-Forwarded-For`. Every attempt must be refused (403 / timeout). If any
   request reaches the app, the configuration is **not** safe: stop.
4. No `client_ip.unresolved` lines for normal traffic.

Raw IPs are never needed for this: only hash counts are compared.

## 6. Misconfiguration behaviour

| Mistake | Effect |
|---|---|
| Variable unset / invalid / `local` | every membership-ID check "temporarily unavailable"; log reason `config_missing_or_invalid` |
| N larger than the real chain | "temporarily unavailable"; reason `chain_too_short` |
| N smaller than the real chain (e.g. `xff-hops:1` behind CloudFront → ALB) | every caller keyed on a CloudFront edge address: callers sharing an edge share a bucket (over-limiting, not spoofing) — caught by §5 step 2 |
| Origin reachable directly | spoofable (see §2) — caught by §5 step 3 |

## 7. Rollback

Unset `KOLEKTO_CLIENT_IP_SOURCE` (fail closed) and redeploy. There is no database
change to roll back.
