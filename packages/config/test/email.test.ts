import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import { ConfigError, type KolektoEnvironment } from "../src/env.ts";
import {
  createEmailSecret,
  describeEmailConfig,
  describeSesIngestionConfig,
  evaluateEmailConfig,
  evaluateSesIngestionConfig,
  loadEmailConfig,
  loadSesIngestionConfig,
  REAL_EMAIL_PROVIDERS,
  type RealEmailConfig,
  type SesIngestionConfig,
} from "../src/email.ts";

const SENTINEL = "not-a-real-key-not-a-real-key"; // deliberately dummy and low-entropy (secret scanners)
const REAL = { realProviders: ["acme"] } as const;

const LOCAL_FAKE = { EMAIL_PROVIDER: "fake", EMAIL_FROM: "no-reply@kolekto.example", APP_BASE_URL: "http://localhost:3000" };
const LOCAL_MAILPIT = { ...LOCAL_FAKE, EMAIL_PROVIDER: "mailpit", EMAIL_SMTP_HOST: "127.0.0.1", EMAIL_SMTP_PORT: "54325" };
const HOSTED = { EMAIL_FROM: "no-reply@kolekto.example", APP_BASE_URL: "https://app.kolekto.example" };
const HOSTED_REAL = { ...HOSTED, EMAIL_PROVIDER: "acme", EMAIL_API_KEY: SENTINEL };

function refuses(fn: () => unknown, pattern: RegExp): ConfigError {
  let caught: unknown;
  assert.throws(fn, (err: unknown) => {
    caught = err;
    return err instanceof ConfigError && pattern.test(err.message);
  });
  return caught as ConfigError;
}

function evaluate(env: Record<string, string>, environment: KolektoEnvironment, real = false) {
  return evaluateEmailConfig(env, environment, real ? REAL : {});
}

describe("1. no real provider exists yet", () => {
  it("REAL_EMAIL_PROVIDERS is empty until P9", () => {
    assert.deepEqual([...REAL_EMAIL_PROVIDERS], []);
  });

  it("production cannot start email at all", () => {
    refuses(() => evaluate({ ...HOSTED, EMAIL_PROVIDER: "fake" }, "production"), /local-only provider/);
    refuses(() => evaluate({ ...HOSTED, EMAIL_PROVIDER: "mailpit" }, "production"), /local-only provider/);
    refuses(() => evaluate({ ...HOSTED, EMAIL_PROVIDER: "acme", EMAIL_API_KEY: SENTINEL }, "production"), /not a supported provider/);
  });
});

describe("2. local and CI cannot use a real provider", () => {
  it("refuses a real provider in local", () => {
    refuses(() => evaluate({ ...LOCAL_FAKE, EMAIL_PROVIDER: "acme", EMAIL_API_KEY: SENTINEL }, "local", true), /local development must never/i);
  });

  it("refuses a real provider in GitHub Actions, even with KOLEKTO_ENV=staging", () => {
    refuses(() => evaluate({ ...HOSTED_REAL, GITHUB_ACTIONS: "true" }, "staging", true), /selected in CI/);
  });

  it("allows fake and mailpit locally", () => {
    assert.equal(evaluate(LOCAL_FAKE, "local").provider, "fake");
    const mailpit = evaluate(LOCAL_MAILPIT, "local");
    assert.equal(mailpit.provider, "mailpit");
    assert.equal((mailpit as { smtpPort: number }).smtpPort, 54325);
  });

  it("allows fake and mailpit in CI when KOLEKTO_ENV=local", () => {
    assert.equal(evaluate({ ...LOCAL_MAILPIT, GITHUB_ACTIONS: "true" }, "local").provider, "mailpit");
  });
});

describe("3. production cannot use the fake adapter", () => {
  it("refuses fake in production", () => {
    refuses(() => evaluate({ ...HOSTED, EMAIL_PROVIDER: "fake" }, "production"), /production/);
  });

  it("refuses mailpit outside local", () => {
    refuses(() => evaluate({ ...HOSTED, EMAIL_PROVIDER: "mailpit", EMAIL_SMTP_HOST: "127.0.0.1", EMAIL_SMTP_PORT: "1025" }, "staging"), /local only/);
  });

  it("allows fake in staging (it delivers nothing, and says so)", () => {
    assert.equal(evaluate({ ...HOSTED, EMAIL_PROVIDER: "fake" }, "staging").provider, "fake");
  });
});

describe("4. missing or invalid configuration fails safely", () => {
  for (const name of ["EMAIL_PROVIDER", "EMAIL_FROM", "APP_BASE_URL"]) {
    it(`requires ${name}`, () => {
      const env: Record<string, string> = { ...LOCAL_FAKE };
      delete env[name];
      refuses(() => evaluate(env, "local"), new RegExp(`Missing required environment variable ${name}`));
    });
  }

  it("treats a blank value as missing", () => {
    refuses(() => evaluate({ ...LOCAL_FAKE, EMAIL_FROM: "   " }, "local"), /EMAIL_FROM/);
  });

  it("rejects an unknown provider without echoing it", () => {
    const err = refuses(() => evaluate({ ...LOCAL_FAKE, EMAIL_PROVIDER: "sk_live_not_a_provider" }, "local"), /not a supported provider/);
    assert.ok(!err.message.includes("sk_live"));
  });

  it("requires the SMTP settings for mailpit, loopback only, valid port", () => {
    refuses(() => evaluate({ ...LOCAL_MAILPIT, EMAIL_SMTP_HOST: "" }, "local"), /EMAIL_SMTP_HOST/);
    refuses(() => evaluate({ ...LOCAL_MAILPIT, EMAIL_SMTP_PORT: "" }, "local"), /EMAIL_SMTP_PORT/);
    refuses(() => evaluate({ ...LOCAL_MAILPIT, EMAIL_SMTP_HOST: "smtp.example.com" }, "local"), /loopback/);
    refuses(() => evaluate({ ...LOCAL_MAILPIT, EMAIL_SMTP_PORT: "70000" }, "local"), /TCP port/);
    refuses(() => evaluate({ ...LOCAL_MAILPIT, EMAIL_SMTP_PORT: "25x" }, "local"), /TCP port/);
  });

  it("requires EMAIL_FROM to be a single plain address", () => {
    for (const bad of ["Kolekto <no-reply@kolekto.example>", "a@b.example\r\nBcc: x@y.example", "not-an-address", "a@b"]) {
      refuses(() => evaluate({ ...LOCAL_FAKE, EMAIL_FROM: bad }, "local"), /EMAIL_FROM/);
    }
  });

  it("validates APP_BASE_URL per environment", () => {
    refuses(() => evaluate({ ...LOCAL_FAKE, APP_BASE_URL: "not a url" }, "local"), /APP_BASE_URL/);
    refuses(() => evaluate({ ...LOCAL_FAKE, APP_BASE_URL: "ftp://localhost" }, "local"), /http or https/);
    refuses(() => evaluate({ ...LOCAL_FAKE, APP_BASE_URL: "https://app.kolekto.example" }, "local"), /not this machine/);
    refuses(() => evaluate({ ...HOSTED, EMAIL_PROVIDER: "fake", APP_BASE_URL: "http://app.kolekto.example" }, "staging"), /not https/);
    refuses(() => evaluate({ ...HOSTED, EMAIL_PROVIDER: "fake", APP_BASE_URL: "https://localhost:3000" }, "staging"), /this machine/);
    refuses(() => evaluate({ ...LOCAL_FAKE, APP_BASE_URL: "http://user:pass@localhost:3000" }, "local"), /credentials/);
  });

  it("normalises APP_BASE_URL to an origin", () => {
    assert.equal(evaluate({ ...LOCAL_FAKE, APP_BASE_URL: "http://localhost:3000/some/path/" }, "local").appBaseUrl, "http://localhost:3000");
  });
});

describe("5. credentials", () => {
  it("refuses EMAIL_API_KEY beside a local provider", () => {
    refuses(() => evaluate({ ...LOCAL_FAKE, EMAIL_API_KEY: SENTINEL }, "local"), /EMAIL_API_KEY is set/);
    refuses(() => evaluate({ ...LOCAL_MAILPIT, EMAIL_API_KEY: SENTINEL }, "local"), /EMAIL_API_KEY is set/);
  });

  it("requires a plausible EMAIL_API_KEY for a real provider", () => {
    const { EMAIL_API_KEY: _omit, ...withoutKey } = HOSTED_REAL;
    void _omit;
    refuses(() => evaluate(withoutKey, "staging", true), /EMAIL_API_KEY is required/);
    refuses(() => evaluate({ ...HOSTED_REAL, EMAIL_API_KEY: "short" }, "staging", true), /too short/);
  });

  it("accepts a real provider in staging and production when everything is present", () => {
    for (const environment of ["staging", "production"] as const) {
      const config = evaluate(HOSTED_REAL, environment, true) as RealEmailConfig;
      assert.equal(config.provider, "acme");
      assert.equal(config.apiKey.reveal(), SENTINEL);
    }
  });

  it("never exposes the key through logging, JSON, interpolation or inspect", () => {
    const config = evaluate(HOSTED_REAL, "staging", true) as RealEmailConfig;
    assert.ok(!JSON.stringify(config).includes(SENTINEL));
    assert.ok(!`${config.apiKey}`.includes(SENTINEL));
    assert.ok(!String(config.apiKey).includes(SENTINEL));
    assert.ok(!inspect(config, { depth: 5 }).includes(SENTINEL));
    assert.ok(!inspect(config.apiKey).includes(SENTINEL));
    assert.ok(!describeEmailConfig(config).includes(SENTINEL));
    assert.equal(createEmailSecret("x").toString(), "[redacted]");
  });

  it("never puts a variable's value in any error message", () => {
    const scenarios: Array<() => unknown> = [
      () => evaluate({ ...HOSTED_REAL, GITHUB_ACTIONS: "true" }, "staging", true),
      () => evaluate({ ...LOCAL_FAKE, EMAIL_API_KEY: SENTINEL }, "local"),
      () => evaluate({ ...LOCAL_FAKE, EMAIL_PROVIDER: "acme", EMAIL_API_KEY: SENTINEL }, "local", true),
      () => evaluate({ ...HOSTED_REAL, EMAIL_FROM: "bad" }, "staging", true),
      () => evaluate({ ...HOSTED_REAL, NEXT_PUBLIC_SOMETHING: SENTINEL }, "staging", true),
      () => evaluate({ ...HOSTED_REAL, EMAIL_API_KEY: SENTINEL, EMAIL_PROVIDER: "nope" }, "production"),
      () => evaluate({ ...HOSTED_REAL, APP_BASE_URL: `http://user:${SENTINEL}@app.kolekto.example` }, "staging", true),
    ];
    for (const run of scenarios) {
      let message = "";
      try {
        run();
        assert.fail("expected a ConfigError");
      } catch (err) {
        assert.ok(err instanceof ConfigError, String(err));
        message = err.message;
      }
      assert.ok(!message.includes(SENTINEL), `error leaked the secret: ${message}`);
    }
  });
});

describe("6. nothing email-related may be public", () => {
  it("refuses a NEXT_PUBLIC_* email setting", () => {
    refuses(() => evaluate({ ...LOCAL_FAKE, NEXT_PUBLIC_EMAIL_API_KEY: "x" }, "local"), /NEXT_PUBLIC_EMAIL_API_KEY/);
    refuses(() => evaluate({ ...LOCAL_FAKE, NEXT_PUBLIC_SMTP_HOST: "x" }, "local"), /NEXT_PUBLIC_SMTP_HOST/);
  });

  it("refuses a NEXT_PUBLIC_* variable that carries the API key value", () => {
    refuses(() => evaluate({ ...HOSTED_REAL, NEXT_PUBLIC_RANDOM_NAME: SENTINEL }, "staging", true), /same value as EMAIL_API_KEY/);
  });

  it("ignores unrelated NEXT_PUBLIC_* variables", () => {
    assert.doesNotThrow(() => evaluate({ ...LOCAL_FAKE, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, "local"));
  });
});

describe("7. loadEmailConfig reads process.env", () => {
  it("returns the validated local config", () => {
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("EMAIL_") || key === "APP_BASE_URL") delete process.env[key];
      }
      Object.assign(process.env, LOCAL_FAKE);
      const config = loadEmailConfig("local");
      assert.equal(config.provider, "fake");
      assert.throws(() => loadEmailConfig("production"), ConfigError);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

// ── SES ingestion configuration (M13.2 P9-2) ─────────────────────────────────

const SES_REGION = "eu-west-1";
const SES_ARN = `arn:aws:sns:${SES_REGION}:123456789012:kolekto-ses-feedback`;

describe("8. SES ingestion configuration", () => {
  it("returns null when neither EMAIL_AWS_REGION nor EMAIL_AWS_SNS_TOPIC_ARN is set", () => {
    assert.equal(evaluateSesIngestionConfig({}), null);
  });

  it("returns the validated shape when both are set and consistent", () => {
    const result = evaluateSesIngestionConfig({ EMAIL_AWS_REGION: SES_REGION, EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN });
    assert.notEqual(result, null);
    const config = result as SesIngestionConfig;
    assert.equal(config.region, SES_REGION);
    assert.equal(config.topicArn, SES_ARN);
    // Default SignatureVersion policy is v2 only (M13.2 P9-2.1 / #17).
    assert.deepEqual([...config.acceptedSignatureVersions], ["2"]);
  });

  it("defaults EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1 to false (v2 only)", () => {
    const config = evaluateSesIngestionConfig({
      EMAIL_AWS_REGION: SES_REGION,
      EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
    }) as SesIngestionConfig;
    assert.deepEqual([...config.acceptedSignatureVersions], ["2"]);
  });

  it("accepts EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1=true as the opt-in to v1+v2", () => {
    const config = evaluateSesIngestionConfig({
      EMAIL_AWS_REGION: SES_REGION,
      EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
      EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1: "true",
    }) as SesIngestionConfig;
    assert.deepEqual([...config.acceptedSignatureVersions], ["1", "2"]);
  });

  it("treats EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1=false as the explicit default (v2 only)", () => {
    const config = evaluateSesIngestionConfig({
      EMAIL_AWS_REGION: SES_REGION,
      EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
      EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1: "false",
    }) as SesIngestionConfig;
    assert.deepEqual([...config.acceptedSignatureVersions], ["2"]);
  });

  it("refuses any other value for EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1 (no silent coercion)", () => {
    refuses(
      () =>
        evaluateSesIngestionConfig({
          EMAIL_AWS_REGION: SES_REGION,
          EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
          EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1: "yes",
        }),
      /EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1/,
    );
    refuses(
      () =>
        evaluateSesIngestionConfig({
          EMAIL_AWS_REGION: SES_REGION,
          EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
          EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1: "1",
        }),
      /EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1/,
    );
  });

  it("refuses a half-configured deploy (only one variable set)", () => {
    refuses(() => evaluateSesIngestionConfig({ EMAIL_AWS_REGION: SES_REGION }), /half configured/);
    refuses(() => evaluateSesIngestionConfig({ EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN }), /half configured/);
  });

  it("refuses a malformed region", () => {
    refuses(() => evaluateSesIngestionConfig({ EMAIL_AWS_REGION: "INVALID", EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN }), /EMAIL_AWS_REGION/);
  });

  it("refuses a malformed topic ARN", () => {
    refuses(
      () => evaluateSesIngestionConfig({ EMAIL_AWS_REGION: SES_REGION, EMAIL_AWS_SNS_TOPIC_ARN: "not-an-arn" }),
      /EMAIL_AWS_SNS_TOPIC_ARN/,
    );
  });

  it("refuses an ARN whose region segment disagrees with EMAIL_AWS_REGION", () => {
    refuses(
      () =>
        evaluateSesIngestionConfig({
          EMAIL_AWS_REGION: SES_REGION,
          EMAIL_AWS_SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:x",
        }),
      /region segment/,
    );
  });

  it("refuses a NEXT_PUBLIC_* variable that mentions AWS/SES/SNS", () => {
    refuses(
      () =>
        evaluateSesIngestionConfig({
          EMAIL_AWS_REGION: SES_REGION,
          EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
          NEXT_PUBLIC_AWS_REGION: SES_REGION,
        }),
      /NEXT_PUBLIC_/,
    );
    refuses(
      () =>
        evaluateSesIngestionConfig({
          EMAIL_AWS_REGION: SES_REGION,
          EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
          NEXT_PUBLIC_SNS_URL: "https://x",
        }),
      /NEXT_PUBLIC_/,
    );
  });

  it("tolerates NEXT_PUBLIC_* variables that do not mention AWS/SES/SNS", () => {
    const r = evaluateSesIngestionConfig({
      EMAIL_AWS_REGION: SES_REGION,
      EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN,
      NEXT_PUBLIC_SUPABASE_URL: "https://x",
    });
    assert.notEqual(r, null);
  });

  it("describeSesIngestionConfig does not leak secrets (the ARN is not a secret)", () => {
    const config = evaluateSesIngestionConfig({ EMAIL_AWS_REGION: SES_REGION, EMAIL_AWS_SNS_TOPIC_ARN: SES_ARN }) as SesIngestionConfig;
    const described = describeSesIngestionConfig(config);
    assert.ok(described.includes(SES_REGION));
    assert.ok(described.includes(SES_ARN));
  });

  it("loadSesIngestionConfig reads process.env", () => {
    const saved = { ...process.env };
    try {
      delete process.env.EMAIL_AWS_REGION;
      delete process.env.EMAIL_AWS_SNS_TOPIC_ARN;
      assert.equal(loadSesIngestionConfig(), null);
      process.env.EMAIL_AWS_REGION = SES_REGION;
      process.env.EMAIL_AWS_SNS_TOPIC_ARN = SES_ARN;
      const result = loadSesIngestionConfig();
      assert.notEqual(result, null);
      assert.equal((result as SesIngestionConfig).region, SES_REGION);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("9. Fake and Mailpit workflows still work without any AWS variables", () => {
  it("evaluateEmailConfig for fake does not demand AWS variables", () => {
    assert.equal(evaluate(LOCAL_FAKE, "local").provider, "fake");
  });
  it("evaluateEmailConfig for mailpit does not demand AWS variables", () => {
    assert.equal(evaluate(LOCAL_MAILPIT, "local").provider, "mailpit");
  });
});
