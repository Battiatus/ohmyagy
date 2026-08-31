import test from "node:test";
import assert from "node:assert/strict";
import { SecretScrubber, defaultSecretScrubber } from "../secret-scrubber.js";
test("WP-3 SecretScrubber: redacts Google Gemini and Vertex AI keys", () => {
    const scrubber = new SecretScrubber();
    const raw = "API Key: AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b in header";
    const scrubbed = scrubber.scrub(raw);
    assert.equal(scrubbed, "API Key: [REDACTED_GEMINI_KEY] in header");
});
test("WP-3 SecretScrubber: redacts OpenAI Project, Admin, Org, and Legacy API keys", () => {
    const scrubber = new SecretScrubber();
    const rawProj = "sk-proj-abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const rawAdmin = "sk-admin-abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const rawOrg = "sk-org-abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const rawLegacy = "sk-1234567890abcdef1234567890abcdef12345678";
    assert.equal(scrubbed(scrubber, rawProj), "[REDACTED_OPENAI_KEY]");
    assert.equal(scrubbed(scrubber, rawAdmin), "[REDACTED_OPENAI_KEY]");
    assert.equal(scrubbed(scrubber, rawOrg), "[REDACTED_OPENAI_KEY]");
    assert.equal(scrubbed(scrubber, rawLegacy), "[REDACTED_OPENAI_KEY]");
});
test("WP-3 SecretScrubber: redacts Anthropic Claude API keys", () => {
    const scrubber = new SecretScrubber();
    const raw1 = "sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890";
    const raw2 = "sk-ant-abcdef1234567890abcdef1234567890abcdef";
    assert.equal(scrubber.scrub(raw1), "[REDACTED_ANTHROPIC_KEY]");
    assert.equal(scrubber.scrub(raw2), "[REDACTED_ANTHROPIC_KEY]");
});
test("WP-3 SecretScrubber: redacts GitHub classic PATs, fine-grained PATs, and OAuth tokens", () => {
    const scrubber = new SecretScrubber();
    const classic = "Token is ghp_1234567890abcdef1234567890abcdef1234";
    const fineGrained = "github_pat_11AAAAAAA001234567890123456789012345678901234567890123456789012345678901234567890";
    const oauth = "gho_1234567890abcdef1234567890abcdef1234";
    assert.equal(scrubber.scrub(classic), "Token is [REDACTED_GITHUB_PAT]");
    assert.equal(scrubber.scrub(fineGrained), "[REDACTED_GITHUB_PAT]");
    assert.equal(scrubber.scrub(oauth), "[REDACTED_GITHUB_TOKEN]");
});
test("WP-3 SecretScrubber: redacts HTTP Authorization Bearer tokens and URL basic credentials", () => {
    const scrubber = new SecretScrubber();
    const bearer = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secretSignature123";
    const url = "Connecting to https://admin:mySecretPass123@api.internal.domain/v1/endpoint";
    assert.equal(scrubber.scrub(bearer), "Authorization: Bearer [REDACTED_BEARER_TOKEN]");
    assert.equal(scrubber.scrub(url), "Connecting to https://[REDACTED_CREDENTIALS]@api.internal.domain/v1/endpoint");
});
test("WP-3 SecretScrubber: redacts AWS access keys, Slack tokens, and PEM private keys", () => {
    const scrubber = new SecretScrubber();
    const aws = "AWS key AKIAIOSFODNN7EXAMPLE used";
    const slack = "Slack token xoxb-123456789012-1234567890123-abcdef123456";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y3...\n-----END RSA PRIVATE KEY-----";
    assert.equal(scrubber.scrub(aws), "AWS key [REDACTED_AWS_KEY] used");
    assert.equal(scrubber.scrub(slack), "Slack token [REDACTED_SLACK_TOKEN]");
    assert.equal(scrubber.scrub(pem), "[REDACTED_PRIVATE_KEY]");
});
test("WP-3 SecretScrubber: dynamically redacts environment variables matching sensitive names", () => {
    const customEnv = {
        MY_CUSTOM_API_KEY: "secret_custom_api_val_9999",
        SERVICE_TOKEN: "service_token_val_888888",
        REGULAR_VAR: "public_value_not_redacted",
    };
    const scrubber = new SecretScrubber({ customEnv });
    const text = "Values: secret_custom_api_val_9999 and service_token_val_888888 and public_value_not_redacted";
    const scrubbed = scrubber.scrub(text);
    assert.equal(scrubbed, "Values: [REDACTED_ENV_MY_CUSTOM_API_KEY] and [REDACTED_ENV_SERVICE_TOKEN] and public_value_not_redacted");
});
test("WP-3 SecretScrubber: supports generic masking and custom secret lists", () => {
    const scrubber = new SecretScrubber({
        genericMask: true,
        customSecrets: ["my_special_secret_code_12345"],
    });
    const text = "Key AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b and my_special_secret_code_12345";
    const scrubbed = scrubber.scrub(text);
    assert.equal(scrubbed, "Key [REDACTED_SECRET] and [REDACTED_SECRET]");
});
test("WP-3 SecretScrubber: recursively scrubs deep JSON objects, arrays, and preserves non-string primitives", () => {
    const scrubber = new SecretScrubber();
    const data = {
        user: "alice",
        age: 30,
        active: true,
        keys: ["AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b", "safe_string"],
        nested: {
            token: "ghp_1234567890abcdef1234567890abcdef1234",
            nullValue: null,
        },
    };
    const scrubbed = scrubber.scrubObject(data);
    assert.deepEqual(scrubbed, {
        user: "alice",
        age: 30,
        active: true,
        keys: ["[REDACTED_GEMINI_KEY]", "safe_string"],
        nested: {
            token: "[REDACTED_GITHUB_PAT]",
            nullValue: null,
        },
    });
});
test("WP-3 SecretScrubber: guarantees ReDoS resistance on 100,000 character repetitious payloads in linear time", () => {
    const scrubber = defaultSecretScrubber;
    const largeText = "sk-proj-".repeat(12500); // 100,000 chars
    const start = Date.now();
    const result = scrubber.scrub(largeText);
    const elapsed = Date.now() - start;
    assert.ok(typeof result === "string");
    assert.ok(elapsed < 200, `Scrubbing took ${elapsed}ms, expected < 200ms`);
});
function scrubbed(scrubber, text) {
    return scrubber.scrub(text);
}
