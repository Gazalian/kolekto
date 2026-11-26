import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertEnvironmentTarget,
  ConfigError,
  LEGACY_PROJECT_REFS,
  loadClientIpSource,
  loadConfig,
  parseClientIpSource,
  projectRefFromUrl,
  resetConfigCache,
  type KolektoEnvironment,
} from "../src/env.ts";

const LOCAL_URL = "http://127.0.0.1:54321";
const STAGING_REF = "kwolxuoeqwuedydxzncb";
const STAGING_URL = `https://${STAGING_REF}.supabase.co`;
const LEGACY_PRODUCTION_REF = "busfgcmbndleljklrcbd";
const LEGACY_TEST_REF = "lpeeckqsltxohppheucz";
const UNKNOWN_REF = "abcdefghijklmnopqrst";

function check(environment: KolektoEnvironment, supabaseUrl: string, expectedProjectRef?: string): void {
  assertEnvironmentTarget({ environment, supabaseUrl, projectRef: projectRefFromUrl(supabaseUrl), expectedProjectRef });
}

function refuses(fn: () => void, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => err instanceof ConfigError && pattern.test(err.message));
}

describe("1. local stays local", () => {
  it("accepts the local stack", () => {
    assert.doesNotThrow(() => check("local", LOCAL_URL));
    assert.doesNotThrow(() => check("local", "http://localhost:54321"));
    assert.doesNotThrow(() => check("local", "http://[::1]:54321"));
  });

  it("refuses any hosted project, even staging", () => {
    refuses(() => check("local", STAGING_URL, STAGING_REF), /not this machine/);
  });
});

describe("2. staging stays staging", () => {
  it("accepts the staging project when it is the expected one", () => {
    assert.doesNotThrow(() => check("staging", STAGING_URL, STAGING_REF));
  });

  it("refuses the local stack", () => {
    refuses(() => check("staging", LOCAL_URL, STAGING_REF), /not a hosted Supabase project URL/);
  });
});

describe("3. legacy production is refused", () => {
  for (const env of ["local", "staging"] as const) {
    it(`by ${env}`, () => {
      refuses(() => check(env, `https://${LEGACY_PRODUCTION_REF}.supabase.co`, LEGACY_PRODUCTION_REF), /LEGACY PRODUCTION/);
    });
  }

  it("however the URL is spelled — a pooler, a proxy, upper case", () => {
    refuses(() => check("staging", `https://aws-0-eu-central-1.pooler.supabase.com/${LEGACY_PRODUCTION_REF}`, STAGING_REF), /LEGACY PRODUCTION/);
    refuses(() => check("staging", `https://${LEGACY_PRODUCTION_REF.toUpperCase()}.SUPABASE.CO`, STAGING_REF), /LEGACY PRODUCTION/);
  });

  it("even when an expected ref is set to it — naming legacy explicitly does not unlock it", () => {
    refuses(() => check("staging", `https://${LEGACY_PRODUCTION_REF}.supabase.co`, LEGACY_PRODUCTION_REF), /LEGACY PRODUCTION/);
  });
});

describe("4. legacy test is refused", () => {
  for (const env of ["local", "staging"] as const) {
    it(`by ${env}`, () => {
      refuses(() => check(env, `https://${LEGACY_TEST_REF}.supabase.co`, LEGACY_TEST_REF), /LEGACY TEST/);
    });
  }
});

describe("5. an unknown hosted project needs explicit configuration", () => {
  it("staging without KOLEKTO_EXPECTED_PROJECT_REF is refused", () => {
    refuses(() => check("staging", STAGING_URL), /KOLEKTO_EXPECTED_PROJECT_REF is not set/);
  });

  it("staging pointed at a project other than the expected one is refused", () => {
    refuses(() => check("staging", `https://${UNKNOWN_REF}.supabase.co`, STAGING_REF), /must name the same project/);
  });

  it("an unknown project is accepted only once it is named on both sides", () => {
    assert.doesNotThrow(() => check("staging", `https://${UNKNOWN_REF}.supabase.co`, UNKNOWN_REF));
  });
});

describe("6. production is controlled separately", () => {
  it("is not held to the local or staging rules", () => {
    assert.doesNotThrow(() => check("production", `https://${UNKNOWN_REF}.supabase.co`));
  });

  it("still never reaches the legacy estate", () => {
    refuses(() => check("production", `https://${LEGACY_PRODUCTION_REF}.supabase.co`), /LEGACY PRODUCTION/);
    refuses(() => check("production", `https://${LEGACY_TEST_REF}.supabase.co`), /LEGACY TEST/);
  });
});

describe("the legacy list itself", () => {
  it("names exactly the two legacy projects", () => {
    assert.deepEqual(Object.keys(LEGACY_PROJECT_REFS).sort(), [LEGACY_PRODUCTION_REF, LEGACY_TEST_REF].sort());
  });
});

describe("loadConfig applies the guards", () => {
  const saved = { ...process.env };
  beforeEach(() => resetConfigCache());
  afterEach(() => {
    process.env = { ...saved };
    resetConfigCache();
  });

  function env(values: Record<string, string>): void {
    for (const k of ["KOLEKTO_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
                     "KOLEKTO_EXPECTED_PROJECT_REF", "KOLEKTO_PRODUCTION_PROJECT_REF"]) delete process.env[k];
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_only" }, values);
  }

  it("loads a local configuration", () => {
    env({ KOLEKTO_ENV: "local", NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL });
    assert.equal(loadConfig().environment, "local");
  });

  it("loads a staging configuration naming its project", () => {
    env({ KOLEKTO_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: STAGING_URL, KOLEKTO_EXPECTED_PROJECT_REF: STAGING_REF });
    assert.equal(loadConfig().projectRef, STAGING_REF);
  });

  it("refuses to start pointed at legacy production", () => {
    env({ KOLEKTO_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: `https://${LEGACY_PRODUCTION_REF}.supabase.co`, KOLEKTO_EXPECTED_PROJECT_REF: STAGING_REF });
    refuses(() => loadConfig(), /LEGACY PRODUCTION/);
  });

  it("keeps the existing KOLEKTO_PRODUCTION_PROJECT_REF guard", () => {
    env({
      KOLEKTO_ENV: "staging",
      NEXT_PUBLIC_SUPABASE_URL: `https://${UNKNOWN_REF}.supabase.co`,
      KOLEKTO_EXPECTED_PROJECT_REF: UNKNOWN_REF,
      KOLEKTO_PRODUCTION_PROJECT_REF: UNKNOWN_REF,
    });
    refuses(() => loadConfig(), /PRODUCTION Supabase project/);
  });
});

describe("client-IP source (KOLEKTO_CLIENT_IP_SOURCE)", () => {
  it("local: defaults to local mode when unset, and accepts it explicitly", () => {
    assert.deepEqual(parseClientIpSource(undefined, "local"), { mode: "local" });
    assert.deepEqual(parseClientIpSource("   ", "local"), { mode: "local" });
    assert.deepEqual(parseClientIpSource("local", "local"), { mode: "local" });
  });

  it("vercel staging: accepts the vercel source", () => {
    assert.deepEqual(parseClientIpSource("vercel", "staging"), { mode: "vercel" });
    assert.deepEqual(parseClientIpSource(" vercel ", "staging"), { mode: "vercel" });
  });

  it("accepts xff-hops:1..3 in every environment (production value itself is pending, not set anywhere)", () => {
    for (const environment of ["local", "staging", "production"] as const) {
      assert.deepEqual(parseClientIpSource("xff-hops:1", environment), { mode: "xff-hops", hops: 1 });
      assert.deepEqual(parseClientIpSource("xff-hops:2", environment), { mode: "xff-hops", hops: 2 });
      assert.deepEqual(parseClientIpSource("xff-hops:3", environment), { mode: "xff-hops", hops: 3 });
    }
  });

  it("refuses a missing source in staging and in production (no default there)", () => {
    for (const environment of ["staging", "production"] as const) {
      refuses(() => parseClientIpSource(undefined, environment), /KOLEKTO_CLIENT_IP_SOURCE is not set/);
      refuses(() => parseClientIpSource("", environment), /KOLEKTO_CLIENT_IP_SOURCE is not set/);
    }
  });

  it("refuses the local-only mode in staging and in production", () => {
    refuses(() => parseClientIpSource("local", "staging"), /allowed only when KOLEKTO_ENV is "local"/);
    refuses(() => parseClientIpSource("local", "production"), /allowed only when KOLEKTO_ENV is "local"/);
  });

  it("refuses unsupported modes, headers and hop counts, without echoing the value", () => {
    const bad = [
      "x-forwarded-for", "x-real-ip", "header:x-real-ip", "header:x-vercel-forwarded-for", "cf-connecting-ip",
      "VERCEL", "Local", "xff-hops", "xff-hops:", "xff-hops:0", "xff-hops:4", "xff-hops:10", "xff-hops:-1",
      "xff-hops:1.5", "xff-hops: 1", "xff-hops:1;vercel", "socket", "none", "trust-all",
    ];
    for (const value of bad) {
      for (const environment of ["local", "staging", "production"] as const) {
        assert.throws(
          () => parseClientIpSource(value, environment),
          // The message lists the allowed values; beyond that it must not repeat what was configured.
          (err: unknown) =>
            err instanceof ConfigError &&
            /unsupported value/.test(err.message) &&
            !err.message.replace(/Allowed: .*$/, "").includes(value),
          `${value} in ${environment}`,
        );
      }
    }
  });

  describe("loadClientIpSource() reads the environment", () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });
    function env(values: Record<string, string>): void {
      delete process.env.KOLEKTO_ENV;
      delete process.env.KOLEKTO_CLIENT_IP_SOURCE;
      Object.assign(process.env, values);
    }

    it("local with nothing set → local", () => {
      env({ KOLEKTO_ENV: "local" });
      assert.deepEqual(loadClientIpSource(), { mode: "local" });
    });

    it("staging with vercel → vercel", () => {
      env({ KOLEKTO_ENV: "staging", KOLEKTO_CLIENT_IP_SOURCE: "vercel" });
      assert.deepEqual(loadClientIpSource(), { mode: "vercel" });
    });

    it("production with nothing set → refused", () => {
      env({ KOLEKTO_ENV: "production" });
      refuses(() => loadClientIpSource(), /KOLEKTO_CLIENT_IP_SOURCE is not set/);
    });

    it("production with local → refused", () => {
      env({ KOLEKTO_ENV: "production", KOLEKTO_CLIENT_IP_SOURCE: "local" });
      refuses(() => loadClientIpSource(), /allowed only when KOLEKTO_ENV is "local"/);
    });

    it("missing KOLEKTO_ENV → refused (never assumed local)", () => {
      env({ KOLEKTO_CLIENT_IP_SOURCE: "local" });
      refuses(() => loadClientIpSource(), /Missing required environment variable KOLEKTO_ENV/);
    });

    it("unknown KOLEKTO_ENV → refused", () => {
      env({ KOLEKTO_ENV: "prod", KOLEKTO_CLIENT_IP_SOURCE: "vercel" });
      refuses(() => loadClientIpSource(), /KOLEKTO_ENV is/);
    });
  });
});
