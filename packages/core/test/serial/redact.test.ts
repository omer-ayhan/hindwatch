/** Holds timing ratios, so npm test runs it alone after the parallel files, which would skew them. */
import assert from "node:assert/strict";
import { Clocks, DEFAULT_RULES, EventBuffer, Ingest, luhnOk, MAX_MSG_CHARS, Redactor } from "@hindwatch/core";
import { test } from "../timed.js";

test("default rules redact bearer tokens, JWTs, emails and key=value secrets", () => {
  const r = new Redactor();
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
  const out = r.redact(`Authorization: Bearer abc.def-123 jwt=${jwt} user ada@example.com api_key=sk_live_9 password: "hunter2"`);
  for (const secret of ["abc.def-123", jwt, "ada@example.com", "sk_live_9", "hunter2"]) {
    assert.ok(!out.includes(secret), `leaked ${secret} in: ${out}`);
  }
  assert.match(out, /Bearer \[REDACTED:bearer\]/);
});


test("default rules cover the security engineer's 11 shapes, and a Luhn failure stays visible", () => {
  const r = new Redactor();
  const ghp = "ghp_123456789012345678901234567890123456";
  const sk = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
  const shapes: ReadonlyArray<{ name: string; input: string; leaked: string; keep?: RegExp }> = [
    { name: "Cookie", input: "Cookie: session=abc123secret", leaked: "abc123secret", keep: /Cookie:\s*\[REDACTED:cookie\]/ },
    { name: "Set-Cookie", input: "Set-Cookie: sid=xyz; HttpOnly", leaked: "sid=xyz", keep: /Set-Cookie:\s*\[REDACTED:cookie\]/ },
    { name: "spaced card", input: "pay 4111 1111 1111 1111 now", leaked: "4111 1111 1111 1111", keep: /\[REDACTED:card\]/ },
    { name: "pan=", input: "pan=4111111111111111", leaked: "4111111111111111", keep: /\[REDACTED:card\]/ },
    { name: "Authorization Token", input: "Authorization: Token tok_abc.def", leaked: "tok_abc.def", keep: /Authorization: Token \[REDACTED:authorization\]/ },
    { name: "client_secret", input: "client_secret=super_secret_value", leaked: "super_secret_value", keep: /client_secret=\[REDACTED:secret\]/ },
    { name: "ghp_", input: `auth ${ghp}`, leaked: ghp, keep: /\[REDACTED:vendor-key\]/ },
    { name: "sk-proj-", input: `key ${sk}`, leaked: sk, keep: /\[REDACTED:vendor-key\]/ },
    { name: "Bearer", input: "Authorization: Bearer abc.def-123", leaked: "abc.def-123", keep: /Bearer \[REDACTED:bearer\]/ },
    { name: "email", input: "user ada@example.com", leaked: "ada@example.com", keep: /\[REDACTED:email\]/ },
    { name: "password", input: 'password: "hunter2"', leaked: "hunter2", keep: /password: "\[REDACTED:secret\]/ },
  ];
  assert.equal(shapes.length, 11);
  for (const { name, input, leaked, keep } of shapes) {
    const out = r.redact(input);
    assert.ok(!out.includes(leaked), `${name}: leaked ${leaked} in: ${out}`);
    if (keep) assert.match(out, keep, `${name}: ${out}`);
  }
  assert.ok(luhnOk("4111111111111111"));
  assert.ok(!luhnOk("4111111111111112"));
  const intact = "order 4111111111111112 pending";
  assert.equal(r.redact(intact), intact);
});

test("keys ending in a secret word are redacted whole, quoted values included", () => {
  const r = new Redactor();
  const cases: ReadonlyArray<{ input: string; leaked: string }> = [
    { input: "authToken=abc123def", leaked: "abc123def" },
    { input: "{ sessionToken: '9f8e7d' }", leaked: "9f8e7d" },
    { input: "clientSecret=s3cr3t", leaked: "s3cr3t" },
    { input: "db_password=hunter2", leaked: "hunter2" },
    { input: "user_password: hunter3 next", leaked: "hunter3" },
    { input: "privateKey=MIIabcdef", leaked: "MIIabcdef" },
    { input: '{"password": "correct horse battery"}', leaked: "horse" },
    { input: String.raw`{\"password\": \"correct horse\", \"user\": 1}`, leaked: "horse" },
    { input: String.raw`{"password":"a\"b c","next":1}`, leaked: "b c" },
  ];
  for (const { input, leaked } of cases) {
    const out = r.redact(input);
    assert.ok(!out.includes(leaked), `leaked ${leaked} in: ${out}`);
    assert.match(out, /\[REDACTED:secret\]/);
    assert.equal(r.redact(out), out, "redacting twice changes nothing");
  }
  assert.equal(r.redact('{"password": "a b", "next": 1}'), '{"password": "[REDACTED:secret]", "next": 1}');
  assert.equal(r.redact("maxTokens=100 tokenCount=5"), "maxTokens=100 tokenCount=5");
});

test("structured attrs are redacted by value and by sensitive key", () => {
  const r = new Redactor();
  const out = r.redactValue({ headers: { Cookie: "sid=1", accept: "json" }, users: ["bo@x.io"], token: 42 });
  assert.deepEqual(out, {
    headers: { Cookie: "[REDACTED:Cookie]", accept: "json" },
    users: ["[REDACTED:email]"],
    token: "[REDACTED:token]",
  });
});

test("plugins can add rules, and rules without the g flag still replace every match", () => {
  const r = new Redactor();
  r.add({ name: "card", pattern: /\b\d{4}-\d{4}\b/ });
  assert.equal(r.redact("1234-5678 and 8765-4321"), "[REDACTED:card] and [REDACTED:card]");
});

test("redaction has no off switch", () => {
  const r = new Redactor();
  const api = Object.getOwnPropertyNames(Object.getPrototypeOf(r));
  assert.deepEqual(api.sort(), ["add", "constructor", "redact", "redactValue"]);
});

test("nothing unredacted reaches the buffer", () => {
  const buffer = new EventBuffer({ maxEvents: 10, maxEventsPerSource: 10, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  ingest.ingest({
    source: "js",
    deviceId: "d",
    app: "a",
    level: "info",
    msg: "login ada@example.com",
    attrs: { password: "hunter2" },
  });
  const stored = JSON.stringify(buffer.snapshot());
  assert.ok(!stored.includes("ada@example.com") && !stored.includes("hunter2"), stored);
});

test("new default rules cover Basic auth, AWS keys and PEM private keys", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----";
  const out = new Redactor().redact(`Authorization: Basic dXNlcjpwYXNz key AKIAIOSFODNN7EXAMPLE ${pem}`);
  for (const secret of ["dXNlcjpwYXNz", "AKIAIOSFODNN7EXAMPLE", "MIIEow"]) assert.ok(!out.includes(secret), out);
});

/** Inputs built to trip a quadratic rule, at any size in characters. */
const ADVERSARIAL: Record<string, (chars: number) => string> = {
  "token chars": (n) => "a".repeat(n),
  "dotted run": (n) => "a.".repeat(n / 2),
  base64: (n) => Buffer.alloc((n * 3) / 4, 7).toString("base64"),
  "many @": (n) => "a@".repeat(n / 2),
  "jwt prefixes": (n) => "eyJa.".repeat(n / 5),
  "unterminated PEM": (n) => `-----BEGIN RSA PRIVATE KEY-----${"x".repeat(n)}`,
  "secret keys": (n) => "authToken=\"a ".repeat(n / 13),
  "unterminated secret": (n) => `password: "${"x ".repeat(n / 2)}`,
  "key without separator": (n) => `${"a".repeat(n)}token`,
};

const adversarial = (chars: number) => Object.values(ADVERSARIAL).map((make) => make(chars));

function bestOf3(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

test("a 1 MB line redacts in under 50 ms through ingest", () => {
  const buffer = new EventBuffer({ maxEvents: 100, maxEventsPerSource: 100, maxAgeMs: 60_000 });
  const ingest = new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer });
  for (const [name, make] of Object.entries(ADVERSARIAL)) {
    const msg = make(1_000_000);
    const ms = bestOf3(() => ingest.ingest({ source: "js", deviceId: "d", app: "a", level: "info", msg }));
    assert.ok(ms < 50, `${name}: a 1 MB line took ${ms.toFixed(1)} ms, limit 50 ms`);
  }
  // "token chars" has no whitespace, so the whole partial token is dropped.
  const [event] = buffer.snapshot();
  assert.equal(event?.msg, "");
  assert.equal(event?.attrs.truncatedChars, 1_000_000);
});

// A ratio, not a time limit, so a loaded machine slows both sizes alike. Linear is 10x, plus cache
// effects at 1 MB; quadratic is 100x.
test("every default rule stays linear: 1 MB takes at most 20x as long as 100 KB", () => {
  const small = adversarial(100_000);
  const large = adversarial(1_000_000);
  for (const rule of DEFAULT_RULES) {
    // The rule alone, as the Redactor applies it, so one slow rule can't hide behind the others.
    const run = (texts: readonly string[]) => () =>
      texts.forEach((text) => {
        const replacement = rule.replacement ?? "";
        if (typeof replacement === "function") text.replace(rule.pattern, replacement);
        else text.replace(rule.pattern, replacement);
      });
    const [largeMs, smallMs] = [bestOf3(run(large)), bestOf3(run(small))];
    const ratio = largeMs / smallMs;
    assert.ok(ratio <= 20, `${rule.name}: 1 MB took ${ratio.toFixed(1)}x as long as 100 KB (${largeMs.toFixed(2)} ms vs ${smallMs.toFixed(2)} ms), limit 20x`);
  }
});

function ingestOne(msg: string) {
  const buffer = new EventBuffer({ maxEvents: 10, maxEventsPerSource: 10, maxAgeMs: 60_000 });
  new Ingest({ redactor: new Redactor(), clocks: new Clocks(), buffer }).ingest({
    source: "js",
    deviceId: "d",
    app: "a",
    level: "info",
    msg,
  });
  const [event] = buffer.snapshot();
  assert.ok(event);
  return event;
}

test("a private key straddling the message cap is not stored", () => {
  const body = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn";
  const lines = Array.from({ length: 1_000 }, () => body).join("\n");
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${lines}\n-----END RSA PRIVATE KEY-----`;
  const prefix = "x ".repeat((MAX_MSG_CHARS - 1_000) / 2);
  const event = ingestOne(`${prefix}${key} tail`);
  assert.ok(event.msg.length <= MAX_MSG_CHARS);
  assert.ok((event.attrs.truncatedChars as number) > 0);
  assert.ok(!event.msg.includes("MIIEow"), "key body leaked past the cut");
  assert.match(event.msg, /\[REDACTED:private-key\]$/);
});

test("the cut drops a trailing partial token so half a secret is not kept", () => {
  const prefix = "word ".repeat(MAX_MSG_CHARS / 5);
  const event = ingestOne(`${prefix.slice(0, MAX_MSG_CHARS - 4)}AKIAIOSFODNN7EXAMPLE more`);
  assert.ok(!event.msg.includes("AKIA"), event.msg.slice(-40));
  assert.match(event.msg, /\s$/);
  assert.equal(event.attrs.truncatedChars, MAX_MSG_CHARS - 4 + 25 - event.msg.length);
});

test("an unterminated private key is redacted to the end of the string", () => {
  const out = new Redactor().redact("boot -----BEGIN EC PRIVATE KEY-----\nMHcCAQEEI");
  assert.equal(out, "boot [REDACTED:private-key]");
});

test("zero-filled IDs, decimals and numbers outside the payment industries are not redacted as cards", () => {
  const r = new Redactor();
  // Luhn-valid by chance, from an emulator's logcat: an epoch-ms time, a frame time in uptime ns, and a duration's fraction.
  for (const line of [
    "lease expiry: 1793430745275 current time: 1793344378442",
    "HandleInputStart=7096838276716, AnimationStart",
    "with size [-2147483648x-2147483648] in 178.39149999999998 ms",
  ]) {
    assert.equal(r.redact(line), line);
  }
  const uuid = "activity(00000000-0000-0000-0000-000000000000)";
  assert.equal(r.redact(uuid), uuid);
  assert.equal(r.redact("id 0000000000000000"), "id 0000000000000000");
  // Real PANs still redact.
  assert.match(r.redact("pay 4111 1111 1111 1111 now"), /\[REDACTED:card\]/);
  assert.match(r.redact("pan=4111111111111111"), /\[REDACTED:card\]/);
});

test("Authorization redaction keeps a closing quote around the header value", () => {
  const r = new Redactor();
  const quoted = `-H "Authorization:Api-Key secretkey123" "https://api.example.com"`;
  const out = r.redact(quoted);
  assert.equal(out, `-H "Authorization:Api-Key [REDACTED:authorization]" "https://api.example.com"`);
  assert.ok(!out.includes("secretkey123"), out);
  const spaced = `Authorization: Token tok_abc.def' trailing`;
  assert.equal(r.redact(spaced), "Authorization: Token [REDACTED:authorization]' trailing");
});
