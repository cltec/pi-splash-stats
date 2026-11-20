import assert from "node:assert/strict";
import test from "node:test";

import {
  discoveryUrl,
  isDiscoveryCandidate,
  MAX_RESPONSE_BYTES,
  normalizeEndpoint,
  validateIdentityResponse,
} from "../src/identity.ts";

test("normalizeEndpoint strips only semantically insignificant trailing slashes", () => {
  assert.equal(normalizeEndpoint("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1");
  assert.equal(normalizeEndpoint("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(normalizeEndpoint("http://127.0.0.1:1234/"), "http://127.0.0.1:1234");
  assert.equal(normalizeEndpoint("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
  assert.equal(normalizeEndpoint("http://host/v1///"), "http://host/v1");
});

test("normalizeEndpoint preserves prefixes, ports, queries, and IPv6 syntax", () => {
  assert.equal(normalizeEndpoint("http://host/gateway/v1/"), "http://host/gateway/v1");
  assert.equal(normalizeEndpoint("http://host:8080/v1"), "http://host:8080/v1");
  assert.equal(normalizeEndpoint("http://host:9090/v1"), "http://host:9090/v1");
  assert.equal(normalizeEndpoint("http://host/v1?x=1"), "http://host/v1?x=1");
  assert.equal(normalizeEndpoint("http://[::1]:1234/v1/"), "http://[::1]:1234/v1");
  assert.equal(normalizeEndpoint("https://splash.example/splash/v1/"), "https://splash.example/splash/v1");
});

test("normalizeEndpoint never collapses distinct mounts or ports into one identity", () => {
  assert.notEqual(normalizeEndpoint("http://host/a/v1"), normalizeEndpoint("http://host/b/v1"));
  assert.notEqual(normalizeEndpoint("http://host:1/v1"), normalizeEndpoint("http://host:2/v1"));
  assert.notEqual(normalizeEndpoint("http://host/v1"), normalizeEndpoint("http://host/v2"));
});

test("normalizeEndpoint rejects invalid URLs and non-HTTP(S) schemes", () => {
  assert.equal(normalizeEndpoint(""), null);
  assert.equal(normalizeEndpoint("not a url"), null);
  assert.equal(normalizeEndpoint("ftp://host/v1"), null);
  assert.equal(normalizeEndpoint("file:///tmp/v1"), null);
});

test("discoveryUrl appends /models under the configured base path", () => {
  assert.equal(discoveryUrl("http://127.0.0.1:1234/splash/v1"), "http://127.0.0.1:1234/splash/v1/models");
});

test("candidate rule: openai-completions with a valid HTTP(S) base, any provider name", () => {
  assert.equal(isDiscoveryCandidate({ api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1" }), true);
  assert.equal(isDiscoveryCandidate({ api: "openai-completions", baseUrl: "https://remote.example/gw/v1" }), true);
  assert.equal(isDiscoveryCandidate({ api: "openai-completions", baseUrl: "http://[::1]:1234/v1" }), true);
  // Provider names are launcher conventions, never eligibility evidence.
  assert.equal(isDiscoveryCandidate({ api: "openai-completions", baseUrl: "http://host/v1" }), true);
});

test("candidate rule: unsupported APIs and invalid URLs are not candidates", () => {
  assert.equal(isDiscoveryCandidate({ api: "openai-responses", baseUrl: "http://host/v1" }), false);
  assert.equal(isDiscoveryCandidate({ api: "anthropic-messages", baseUrl: "http://host/v1" }), false);
  assert.equal(isDiscoveryCandidate({ api: "openai-completions" }), false);
  assert.equal(isDiscoveryCandidate({ api: "openai-completions", baseUrl: "unix:///v1" }), false);
  assert.equal(isDiscoveryCandidate({}), false);
});

const splashList = (entries: unknown[]) => ({ object: "list", data: entries });

test("identity: exact id match with owned_by splash verifies", () => {
  assert.equal(
    validateIdentityResponse(splashList([{ id: "verify-model", object: "model", owned_by: "splash" }]), "verify-model"),
    true,
  );
  // Served aliases: the requested id appears alongside others.
  assert.equal(
    validateIdentityResponse(
      splashList([
        { id: "alias-1", owned_by: "splash" },
        { id: "verify-model", owned_by: "splash" },
      ]),
      "verify-model",
    ),
    true,
  );
});

test("identity: id mismatch, wrong owner, and case differences do not verify", () => {
  assert.equal(validateIdentityResponse(splashList([{ id: "other-model", owned_by: "splash" }]), "verify-model"), false);
  assert.equal(validateIdentityResponse(splashList([{ id: "verify-model", owned_by: "llama.cpp" }]), "verify-model"), false);
  assert.equal(validateIdentityResponse(splashList([{ id: "verify-model", owned_by: "Splash" }]), "verify-model"), false);
  assert.equal(validateIdentityResponse(splashList([{ id: "verify-model" }]), "verify-model"), false);
});

test("identity: non-objects, malformed lists, and string coercion are rejected", () => {
  assert.equal(validateIdentityResponse(null, "m"), false);
  assert.equal(validateIdentityResponse("[]", "m"), false);
  assert.equal(validateIdentityResponse([], "m"), false);
  assert.equal(validateIdentityResponse({ data: "nope" }, "m"), false);
  assert.equal(validateIdentityResponse({ data: [42, "m", null] }, "m"), false);
  assert.equal(validateIdentityResponse({ data: [{ id: "m", owned_by: "splash", extra: 1 }] }, "m"), true);
  assert.equal(validateIdentityResponse({ data: [{ id: 123, owned_by: "splash" }] }, "123"), false);
});

test("identity: oversized bodies are bounded (1 MiB constant)", () => {
  assert.equal(MAX_RESPONSE_BYTES, 1024 * 1024);
});
