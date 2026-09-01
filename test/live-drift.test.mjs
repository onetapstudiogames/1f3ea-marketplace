import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLiveTruth,
  validateLiveTruth,
} from "../scripts/check-live-truth.mjs";

const reviewedOfficialFacts = {
  domain: "https://1f3ea.com",
  treasury: "0x3b9d230c9b995fb1a10add2d63ce37437916dcfd",
  network: "base",
  usdc_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  listing_fee_usdc: 1,
  public_pagination: {
    completeness:
      "Every bounded collection reports an exact total, returned count, page size, has_more, and a continuation cursor. A null continuation means the response is complete.",
  },
};

const reviewedLlmsClaims = `
> Listings cost $1 USDC on Base via x402.
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
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace(
          "call front_door first, then official_facts",
          "open the website before trying connector tools",
        ),
      }),
    /connector-first/iu,
  );
  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace("via x402", "by wire transfer"),
      }),
    /x402/iu,
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
        llmsText: reviewedLlmsClaims.replace(
          "A 502 means the facilitator rejected a request without identifying whether the proof, the market's requirements, or facilitator handling was at fault; do not replace or replay the proof blindly",
          "A 502 means the facilitator rejected a request because the proof is definitely invalid; do not replace or replay the proof blindly",
        ),
      }),
    /502/iu,
  );
  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace(
          "retry the same proof",
          "make a replacement payment",
        ),
      }),
    /503/iu,
  );
  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          public_pagination: {
            completeness: "Collections return a first page.",
          },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /pagination/iu,
  );
  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          public_pagination: {
            completeness:
              "Every bounded collection reports not an exact total, returned count, page size, has_more, and a continuation cursor. A null continuation means the response is complete.",
          },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /pagination/iu,
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
    /pagination/iu,
  );
  assert.throws(
    () =>
      validateLiveTruth({
        official: reviewedOfficialFacts,
        llmsText: reviewedLlmsClaims.replace(
          "reports an exact total plus",
          "reports not an exact total plus",
        ),
      }),
    /pagination/iu,
  );
});

test("negated live claims cannot satisfy the truth gate", () => {
  const rejectedLlmsClaims = [
    [
      "connector order",
      reviewedLlmsClaims.replace(
        "call front_door first, then official_facts",
        "do not call front_door first, then official_facts",
      ),
      /connector-first/iu,
    ],
    [
      "connector visit",
      reviewedLlmsClaims.replace(
        "Start every visit through an available connector",
        "Do not start every visit through an available connector",
      ),
      /connector-first/iu,
    ],
    [
      "connector precedence",
      reviewedLlmsClaims.replace(
        "Start every visit through an available connector: call front_door first, then official_facts.",
        "Start every visit at https://1f3ea.com/ before using the connector: call front_door first, then official_facts.",
      ),
      /connector-first/iu,
    ],
    [
      "URL fallback",
      reviewedLlmsClaims.replace(
        "The front-door fallback is https://1f3ea.com/",
        "The front-door fallback is not https://1f3ea.com/",
      ),
      /connector-first/iu,
    ],
    [
      "URL capability",
      reviewedLlmsClaims.replace(
        "if your client can open URLs",
        "if your client cannot open URLs",
      ),
      /connector-first/iu,
    ],
    [
      "x402 method",
      reviewedLlmsClaims.replace(
        "Listings cost $1 USDC on Base via x402.",
        "Listings cost $1 USDC on Base, but never via x402.",
      ),
      /x402/iu,
    ],
    [
      "listing fee universality",
      reviewedLlmsClaims.replace(
        "Listings cost $1 USDC on Base via x402.",
        "Not all listings cost $1 USDC on Base via x402.",
      ),
      /x402/iu,
    ],
    [
      "502 assertion",
      reviewedLlmsClaims.replace(
        "A 502 means the facilitator rejected",
        "It is false that a 502 means the facilitator rejected",
      ),
      /502/iu,
    ],
    [
      "503 retry",
      reviewedLlmsClaims.replace(
        "retry the same proof",
        "do not retry the same proof",
      ),
      /503/iu,
    ],
    [
      "503 assertion",
      reviewedLlmsClaims.replace(
        "A 503 means payment or chain verification",
        "It is false that a 503 means payment or chain verification",
      ),
      /503/iu,
    ],
    [
      "pending settlement retry",
      reviewedLlmsClaims.replace(
        "A pending or duplicate settlement is 503; retry the same proof",
        "A pending or duplicate settlement is 503; do not retry the same proof",
      ),
      /pending or duplicate/iu,
    ],
    [
      "pending settlement assertion",
      reviewedLlmsClaims.replace(
        "A pending or duplicate settlement is 503",
        "It is false that a pending or duplicate settlement is 503",
      ),
      /pending or duplicate/iu,
    ],
    [
      "pagination completion",
      reviewedLlmsClaims.replace(
        "a null cursor means that view is complete",
        "a null cursor does not mean that view is complete",
      ),
      /pagination/iu,
    ],
    [
      "pagination completion pair",
      reviewedLlmsClaims.replace(
        "has_more=false and a null cursor means that view is complete",
        "has_more=false does not matter; a null cursor means that view is complete",
      ),
      /pagination/iu,
    ],
    [
      "collection universality",
      reviewedLlmsClaims.replace(
        "Every bounded collection reports an exact total",
        "Not every bounded collection reports an exact total",
      ),
      /pagination/iu,
    ],
  ];

  for (const [name, llmsText, expected] of rejectedLlmsClaims) {
    assert.throws(
      () => validateLiveTruth({ official: reviewedOfficialFacts, llmsText }),
      expected,
      name,
    );
  }

  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          public_pagination: {
            completeness:
              "Every bounded collection reports an exact total, returned count, page size, has_more, and a continuation cursor. A null continuation does not mean the response is complete.",
          },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /pagination/iu,
    "official pagination completion",
  );
  assert.throws(
    () =>
      validateLiveTruth({
        official: {
          ...reviewedOfficialFacts,
          public_pagination: {
            completeness:
              "Not every bounded collection reports an exact total, returned count, page size, has_more, and a continuation cursor. A null continuation means the response is complete.",
          },
        },
        llmsText: reviewedLlmsClaims,
      }),
    /pagination/iu,
    "official collection universality",
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

test("a partial outage fails instead of pretending the live market is offline", async () => {
  const partialFetch = async (url) => {
    if (url.endsWith("llms.txt")) throw new TypeError("fetch failed");
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

  const malformedJsonFetch = async (url) =>
    new Response(url.endsWith("llms.txt") ? reviewedLlmsClaims : "not json", {
      status: 200,
    });
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
