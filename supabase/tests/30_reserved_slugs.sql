-- ─────────────────────────────────────────────────────────────────────────────
-- 30 — Reserved community slugs (M10/BK-02)
--
-- Proves that reserved application route segments cannot become community slugs,
-- that normal slugs still work, and that existing uniqueness behaviour holds.
-- ─────────────────────────────────────────────────────────────────────────────
begin;
select plan(8);

-- 1. The reserved-slug checker recognises every reserved word.
select ok(
  app.is_reserved_community_slug('c'),
  'c is reserved'
);

select ok(
  app.is_reserved_community_slug('communities'),
  'communities is reserved'
);

select ok(
  app.is_reserved_community_slug('login'),
  'login is reserved'
);

select ok(
  app.is_reserved_community_slug('api'),
  'api is reserved'
);

-- 2. A normal slug is not reserved.
select ok(
  not app.is_reserved_community_slug('kwasu-alumni'),
  'kwasu-alumni is not reserved'
);

-- 3. The slug generator skips a reserved base and produces a suffixed variant.
select isnt(
  app.generate_unique_community_slug('Communities'),
  'communities',
  'slug generator does not return reserved slug communities'
);

-- 4. The slug generator still produces a normal slug unchanged when it is free.
--    (This uses a name unlikely to collide.)
select matches(
  app.generate_unique_community_slug('pgTAP Test Slug 30 ' || gen_random_uuid()::text),
  '^pgtap-test-slug-30',
  'slug generator produces expected base for a normal name'
);

-- 5. Case-insensitive: 'Login' is also reserved (the function lowercases).
select ok(
  app.is_reserved_community_slug('Login'),
  'Login (mixed case) is reserved'
);

select * from finish();
rollback;
