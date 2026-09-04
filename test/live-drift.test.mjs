import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLiveTruth,
  validateLiveTruth,
} from "../scripts/check-live-truth.mjs";
import { MARKET_REJECTION_MESSAGE } from "../scripts/lib/identity-probe.mjs";

const meRejectionResponse = (errorText = MARKET_REJECTION_MESSAGE) =>
  new Response(JSON.stringify({ error: errorText }), { status: 401 });

const reviewedOfficialFacts = {
  domain: "https://1f3ea.com",
  treasury: "0x3b9d230c9b995fb1a10add2d63ce37437916dcfd",
  network: "base",
  usdc_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  listing_fee_usdc: 1,
  x402_facilitator: {
    verification_retry: "a timeout happens before settlement starts; retry the same request with the same proof",
    settlement_retry: "a timeout may leave the result uncertain; retry the same proof and do not pay again",
  },
  public_pagination: {
    completeness:
      "Every bounded collection reports an exact total, returned count, page size, has_more, and a continuation cursor. A null continuation means the response is complete.",
  },
};

const reviewedLlmsClaims = `
> Listings cost $1 USDC on Base via x402 or a direct seller-wallet-to-treasury transfer.
> Registration is free and agent-native: no accounts or emails; one merchant key and eight one-use recovery codes are saved before creation.
Start every visit through an available connector: call front_door first, then official_facts. The front-door fallback is https://1f3ea.com/ if your client can open URLs.
- Every bounded collection reports an exact total plus returned, page_size, has_more, and a continuation cursor; has_more=false and a null cursor means that view is complete
- A 502 means the facilitator rejected a request without identifying whether the proof, the market's requirements, or facilitator handling was at fault; do not replace or replay the proof blindly
- A 503 means payment or chain verification is unavailable, including an explicit facilitator failure that did not match a known caller mistake; retry the same proof
- A pending or duplicate settlement is 503; retry the same proof and do not pay again
`;

test("reviewed live claims agree across official JSON and llms.txt", () => {
  assert.doesNotThrow(() =>
    validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims,
    }),
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: { ...reviewedOfficialFacts, listing_fee_usdc: 2 },
        llmsText: reviewedLlmsClaims,
      }),
    /listing fee/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          x402_facilitator: { ...reviewedOfficialFacts.x402_facilitator, settlement_retry: "pay again immediately" },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /settlement_retry/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: { ...reviewedOfficialFacts, x402_facilitator: undefined },
        llmsText: reviewedLlmsClaims,
      }),
    /x402_facilitator is missing/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace(
          "call front_door first, then official_facts",
          "open the website before trying connector tools",
        ),
      }),
    /front_door before official_facts/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: { ...reviewedOfficialFacts, listing_fee_usdc: 2 },
        llmsText: reviewedLlmsClaims.replace("$1 USDC", "$2 USDC"),
      }),
    /listing fee/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace("$1 USDC on Base via x402", "$1 USDC on Base via wire transfer"),
      }),
    /x402 rail/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace(
          "do not replace or replay the proof blindly",
          "replace the proof and retry",
        ),
      }),
    /502/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replaceAll("retry the same proof", "make a replacement payment"),
      }),
    /503/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          public_pagination: { completeness: "Collections return a first page." },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /pagination completeness promise changed/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace(
          "Every bounded collection reports an exact total plus returned, page_size, has_more, and a continuation cursor; has_more=false and a null cursor means that view is complete",
          "Every collection returns a first page",
        ),
      }),
    /llms\.txt pagination/iu,
  );
});

// The coding-client identity doors (scripts/setup.mjs, connect.mjs, key.mjs,
// identity-client.mjs all depend on this exact shape) are gated separately
// from the plain identity flags and can legitimately be null while dormant
// -- so this pins the shape ONLY for the case where /api/official actually
// reports the doors present, matching validateLiveTruth's own "only check
// when present" discipline. Without a test pinning this, a server-side
// rename of any one of these fields would silently turn setup.mjs's
// dormant-doors pre-check into a permanent no-op with a fully green suite
// and a green check:live-truth -- the same blind-coverage class the rest of
// this file already closes for every other live claim.
test("live truth pins the identity.coding_client_doors shape whenever /api/official reports it present", () => {
  const domain = reviewedOfficialFacts.domain;
  const reviewedCodingDoors = {
    register: `${domain}/api/register`,
    rotate: `${domain}/api/rotate`,
    recovery: `${domain}/api/recovery`,
    pair: `${domain}/api/pair`,
    client_classes: ["coding_persistent", "coding_ephemeral"],
    registration_requires_human_approved: true,
    key_and_codes_shown_exactly_once: true,
  };

  // Dormant (null) doors are not evidence of drift -- never checked, never
  // thrown on, regardless of what the shape would otherwise require.
  assert.doesNotThrow(() =>
    validateLiveTruth({
      official: { ...reviewedOfficialFacts, identity: { coding_client_doors: null } },
      llmsText: reviewedLlmsClaims,
    }),
  );

  // The reviewed shape, present, must pass cleanly.
  assert.doesNotThrow(() =>
    validateLiveTruth({
      official: { ...reviewedOfficialFacts, identity: { coding_client_doors: reviewedCodingDoors } },
      llmsText: reviewedLlmsClaims,
    }),
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          identity: { coding_client_doors: { ...reviewedCodingDoors, register: `${domain}/api/register-v2` } },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /coding_client_doors\.register changed/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          identity: { coding_client_doors: { ...reviewedCodingDoors, client_classes: ["coding_persistent"] } },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /coding_client_doors\.client_classes changed/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          identity: { coding_client_doors: { ...reviewedCodingDoors, registration_requires_human_approved: false } },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /registration_requires_human_approved changed/iu,
  );

  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          identity: { coding_client_doors: { ...reviewedCodingDoors, key_and_codes_shown_exactly_once: false } },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /key_and_codes_shown_exactly_once changed/iu,
  );
});

test("offline live checks skip honestly only outside required-network CI", async () => {
  const offlineFetch = async () => {
    throw new TypeError("fetch failed");
  };

  const result = await checkLiveTruth({
    fetchImpl: offlineFetch,
    requireNetwork: false,
  });
  assert.equal(result.skipped, true);
  assert.match(result.notice, /SKIP[\s\S]*llms\.txt[\s\S]*api\/official/iu);

  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: offlineFetch, requireNetwork: true }),
    /live truth is required/iu,
  );
});

// Round-5 LOW finding's fix: scripts/lib/identity-probe.mjs pins
// MARKET_REJECTION_MESSAGE -- an unpublished internal literal from a
// separate repo (ref-market) -- as the ONLY string `key adopt` ever treats
// as proof a live entry is dead. Pinning an unpublished string fails
// CLOSED (a reword upstream would make adopt permanently refuse to repair
// the exact stranded-key situation it exists for) unless something catches
// the drift before it strands every future adopt -- this is that gate: an
// anonymous GET (no bearer sent, no credential needed) that fails loudly
// the moment the live market's own 401 JSON error stops matching.
test("check:live-truth pins the market's exact /api/me rejection message, anonymously, no bearer sent", async () => {
  let sawAuthHeader = null;
  const happyFetch = async (url, init) => {
    if (url.endsWith("llms.txt")) return new Response(reviewedLlmsClaims, { status: 200 });
    if (url.endsWith("/api/me")) {
      sawAuthHeader = init?.headers?.authorization ?? init?.headers?.Authorization ?? null;
      return meRejectionResponse();
    }
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 });
  };
  const result = await checkLiveTruth({ fetchImpl: happyFetch, requireNetwork: false });
  assert.equal(result.valid, true);
  assert.equal(sawAuthHeader, null, "the /api/me pin sends no Authorization header -- it needs no credential");

  const rewordedFetch = async (url) => {
    if (url.endsWith("llms.txt")) return new Response(reviewedLlmsClaims, { status: 200 });
    if (url.endsWith("/api/me")) return meRejectionResponse("invalid credentials");
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 });
  };
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: rewordedFetch, requireNetwork: false }),
    /api\/me[\s\S]*401 JSON error changed/iu,
  );

  const wrongStatusFetch = async (url) => {
    if (url.endsWith("llms.txt")) return new Response(reviewedLlmsClaims, { status: 200 });
    if (url.endsWith("/api/me")) return new Response(JSON.stringify({ handle: "anyone" }), { status: 200 });
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 });
  };
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: wrongStatusFetch, requireNetwork: false }),
    /api\/me[\s\S]*not the expected 401/iu,
  );
});

test("a partial outage fails instead of pretending the live market is offline", async () => {
  const partialFetch = async (url) => {
    if (url.endsWith("llms.txt")) throw new TypeError("fetch failed");
    if (url.endsWith("/api/me")) return meRejectionResponse();
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 });
  };

  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: partialFetch, requireNetwork: false }),
    /llms\.txt/iu,
  );
});

test("HTTP, redirect, malformed JSON, and unexpected fetch failures fail loudly", async () => {
  const httpFailureFetch = async () =>
    new Response("temporarily unavailable", { status: 503 });
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: httpFailureFetch }),
    /HTTP 503/iu,
  );

  const redirectFetch = async (url) => ({
    ok: true,
    redirected: true,
    status: 200,
    url: `${url}moved`,
    text: async () => "",
  });
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: redirectFetch }),
    /unexpected redirect/iu,
  );

  const malformedJsonFetch = async (url) => {
    if (url.endsWith("llms.txt")) return new Response(reviewedLlmsClaims, { status: 200 });
    if (url.endsWith("/api/me")) return meRejectionResponse();
    return new Response("not json", { status: 200 });
  };
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: malformedJsonFetch }),
    /malformed JSON/iu,
  );

  const unexpectedFailureFetch = async () => {
    throw new Error("unexpected fetch implementation failure");
  };
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: unexpectedFailureFetch }),
    /unexpected fetch implementation failure/iu,
  );
});

test("a missing fetch implementation fails instead of pretending the network is offline", async () => {
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: null, requireNetwork: false }),
    /requires a fetch implementation/iu,
  );
});

test("the served market facts still match the skill release baseline", async (t) => {
  const result = await checkLiveTruth({
    requireNetwork: process.env.REQUIRE_LIVE_TRUTH === "1",
  });

  if (result.skipped) {
    t.skip(result.notice);
    return;
  }

  assert.equal(result.valid, true);
});
