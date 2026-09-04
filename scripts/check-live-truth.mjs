import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MARKET_REJECTION_MESSAGE } from "./lib/identity-probe.mjs";

const endpoints = {
  llms: "https://1f3ea.com/llms.txt",
  official: "https://1f3ea.com/api/official",
  me: "https://1f3ea.com/api/me",
};

const reviewed = {
  treasury: "0x3b9d230c9b995fb1a10add2d63ce37437916dcfd",
  network: "base",
  usdcContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  listingFeeUsdc: 1,
};

class FetchUnavailableError extends Error {}

const transportErrorCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

const requireClaim = (condition, message) => {
  if (!condition) throw new Error(`live truth mismatch: ${message}`);
};

const compact = (value) => value.replace(/\s+/gu, " ").trim();

const isTransportFailure = (error) => {
  const codes = [error?.code, error?.cause?.code];
  return (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    codes.some((code) => transportErrorCodes.has(code)) ||
    (error instanceof TypeError &&
      /^(?:fetch failed|failed to fetch|network error)/iu.test(error.message))
  );
};

// Every check below is structural: it either compares a fixed, reviewed
// baseline against a field the live /api/official response actually returns,
// or it pulls the expected wording straight out of that same live response
// and checks llms.txt agrees with it. Nothing here pins an independently
// authored copy of a sentence that could quietly drift out of sync with the
// live facts it is supposed to describe.
export const validateLiveTruth = ({ official, llmsText }) => {
  requireClaim(official && typeof official === "object", "/api/official must return a JSON object");
  requireClaim(official.network === reviewed.network, "network must be Base");
  requireClaim(
    String(official.treasury).toLowerCase() === reviewed.treasury,
    `treasury must be ${reviewed.treasury}`,
  );
  requireClaim(
    String(official.usdc_contract).toLowerCase() === reviewed.usdcContract,
    "official USDC contract changed",
  );
  requireClaim(
    official.listing_fee_usdc === reviewed.listingFeeUsdc,
    "listing fee must be 1 USDC",
  );

  const facilitator = official.x402_facilitator;
  requireClaim(facilitator && typeof facilitator === "object", "/api/official x402_facilitator is missing");
  const verificationRetry = compact(String(facilitator.verification_retry ?? ""));
  const settlementRetry = compact(String(facilitator.settlement_retry ?? ""));
  requireClaim(
    /retry the same (?:request|proof)/iu.test(verificationRetry),
    "/api/official x402_facilitator.verification_retry changed",
  );
  requireClaim(
    /retry the same proof/iu.test(settlementRetry) && /do not pay again/iu.test(settlementRetry),
    "/api/official x402_facilitator.settlement_retry changed",
  );

  const pagination = compact(String(official.public_pagination?.completeness ?? ""));
  requireClaim(
    /^every bounded collection reports an exact total.{0,100}returned count.{0,80}page size.{0,80}has_more.{0,100}continuation cursor[.;]\s*(?:a )?null continuation means (?:the )?response is complete/iu.test(
      pagination,
    ),
    "/api/official pagination completeness promise changed",
  );

  // The coding-client identity doors (scripts/setup.mjs, connect.mjs, key.mjs,
  // identity-client.mjs all depend on this exact shape) are gated separately
  // from the plain identity flags and can be null while dormant -- only
  // check their shape when /api/official actually reports them present,
  // so this stays honest about "dormant" vs "changed" rather than treating
  // a currently-dormant door as a live-truth failure.
  const codingDoors = official.identity?.coding_client_doors;
  if (codingDoors) {
    const domain = String(official.domain ?? "");
    for (const doorName of ["register", "rotate", "recovery", "pair"]) {
      requireClaim(
        codingDoors[doorName] === `${domain}/api/${doorName}`,
        `/api/official identity.coding_client_doors.${doorName} changed`,
      );
    }
    requireClaim(
      Array.isArray(codingDoors.client_classes)
        && codingDoors.client_classes.includes("coding_persistent")
        && codingDoors.client_classes.includes("coding_ephemeral"),
      "/api/official identity.coding_client_doors.client_classes changed",
    );
    requireClaim(
      codingDoors.registration_requires_human_approved === true,
      "/api/official identity.coding_client_doors.registration_requires_human_approved changed",
    );
    requireClaim(
      codingDoors.key_and_codes_shown_exactly_once === true,
      "/api/official identity.coding_client_doors.key_and_codes_shown_exactly_once changed",
    );
  }

  const normalizedLlms = compact(llmsText);

  requireClaim(
    /eight one-use recovery codes/iu.test(normalizedLlms),
    "recovery-code count must remain eight",
  );

  // The listing-fee sentence must agree with official.listing_fee_usdc's own
  // live value, not a separately hardcoded "$1" that could go stale.
  const feeLine = llmsText.split(/\r?\n/u).find((entry) => /\$\d+(?:\.\d+)?\s+[A-Z]+\s+on\s+\w+/u.test(entry));
  requireClaim(Boolean(feeLine), "llms.txt listing-fee sentence disagrees with /api/official (sentence not found)");
  const feeSentence = compact(feeLine);
  requireClaim(
    feeSentence.includes(`$${official.listing_fee_usdc}`),
    "llms.txt listing-fee sentence disagrees with /api/official (amount)",
  );
  requireClaim(/\bUSDC\b/iu.test(feeSentence), "llms.txt listing-fee sentence disagrees with /api/official (currency)");
  requireClaim(
    new RegExp(`\\b${official.network}\\b`, "iu").test(feeSentence),
    "llms.txt listing-fee sentence disagrees with /api/official (network)",
  );
  requireClaim(/\bx402\b/iu.test(feeSentence), "llms.txt listing-fee sentence disagrees with /api/official (x402 rail)");
  requireClaim(
    /direct seller-wallet-to-treasury transfer/iu.test(feeSentence),
    "llms.txt listing-fee sentence disagrees with /api/official (direct transfer rail)",
  );

  requireClaim(
    /front_door[\s\S]{0,200}official_facts/iu.test(normalizedLlms),
    "connector-first opening must call front_door before official_facts",
  );
  const domainPattern = String(official.domain ?? "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  requireClaim(
    domainPattern.length > 0 && new RegExp(`${domainPattern}/?[\\s\\S]{0,120}open URLs`, "iu").test(normalizedLlms),
    "front-door URL fallback must reference the official domain and stay conditional on opening URLs",
  );

  requireClaim(
    /\b502\b[\s\S]{0,200}facilitator[\s\S]{0,200}(?:do not|never)[\s\S]{0,60}(?:replace|replay)/iu.test(normalizedLlms),
    "502 guidance must still explain the facilitator rejection and warn against blind proof replay",
  );
  requireClaim(
    /\b503\b[\s\S]{0,200}unavailable[\s\S]{0,220}retry the same proof/iu.test(normalizedLlms),
    "503 guidance must still describe unavailable verification with a same-proof retry",
  );
  requireClaim(
    /pending or duplicate settlement[\s\S]{0,40}\b503\b[\s\S]{0,120}retry the same proof[\s\S]{0,80}do not pay again/iu.test(
      normalizedLlms,
    ),
    "pending/duplicate settlement guidance must remain 503 with a safe same-proof retry",
  );

  requireClaim(
    /exact total[\s\S]{0,140}has_more[\s\S]{0,160}continuation cursor[\s\S]{0,180}has_more=false[\s\S]{0,60}null cursor[\s\S]{0,80}complete/iu.test(
      normalizedLlms,
    ),
    "llms.txt pagination completeness promise changed",
  );
};

const fetchText = async (url, fetchImpl) => {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(10_000),
      headers: {
        accept: url.endsWith(".txt") ? "text/plain" : "application/json",
      },
    });
  } catch (error) {
    const message = `${url}: ${error?.message || String(error)}`;
    if (isTransportFailure(error)) {
      throw new FetchUnavailableError(message, { cause: error });
    }
    throw new Error(message, { cause: error });
  }

  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (response.redirected || (response.url && response.url !== url)) {
    throw new Error(`${url}: unexpected redirect to ${response.url}`);
  }
  return response.text();
};

// Round-5 LOW finding's fix: `scripts/lib/identity-probe.mjs` pins
// MARKET_REJECTION_MESSAGE -- an unpublished internal literal from a
// separate repo -- as the ONLY string that ever counts as `key adopt`
// proving a live entry dead. Pinning an unpublished string fails closed
// (a reword upstream would make adopt permanently refuse to repair the
// exact stranded-key situation it exists for) unless something catches the
// drift. This is that something: one anonymous GET, no bearer sent, so it
// carries no credential and needs none -- proving nothing except that the
// market's own 401 JSON error still reads exactly what the probe expects.
const fetchMeRejection = async (url, fetchImpl) => {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const message = `${url}: ${error?.message || String(error)}`;
    if (isTransportFailure(error)) {
      throw new FetchUnavailableError(message, { cause: error });
    }
    throw new Error(message, { cause: error });
  }

  if (response.redirected || (response.url && response.url !== url)) {
    throw new Error(`${url}: unexpected redirect to ${response.url}`);
  }
  if (response.status !== 401) {
    throw new Error(
      `${url}: anonymous read answered HTTP ${response.status}, not the expected 401 credential rejection`,
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`${url}: 401 body did not parse as JSON (${error.message})`);
  }
  if (body?.error !== MARKET_REJECTION_MESSAGE) {
    throw new Error(
      `${url}: 401 JSON error changed -- expected ${JSON.stringify(MARKET_REJECTION_MESSAGE)}, ` +
        `got ${JSON.stringify(body?.error)}`,
    );
  }
  return true;
};

const failureMessage = (settledResults) =>
  settledResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason.message)
    .join("; ");

export const checkLiveTruth = async ({
  fetchImpl = globalThis.fetch,
  requireNetwork = false,
} = {}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("live truth check requires a fetch implementation");
  }
  if (typeof globalThis.AbortSignal?.timeout !== "function") {
    throw new Error("live truth check requires AbortSignal.timeout support");
  }

  const results = await Promise.allSettled([
    fetchText(endpoints.llms, fetchImpl),
    fetchText(endpoints.official, fetchImpl),
    fetchMeRejection(endpoints.me, fetchImpl),
  ]);
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    const allUnavailable =
      failures.length === results.length &&
      failures.every(
        (result) => result.reason instanceof FetchUnavailableError,
      );
    if (allUnavailable && !requireNetwork) {
      return {
        skipped: true,
        notice: `SKIP live truth: ${endpoints.llms}, ${endpoints.official}, and ${endpoints.me} are offline (${failureMessage(results)})`,
      };
    }
    const prefix = requireNetwork ? "live truth is required; " : "";
    throw new Error(`${prefix}${failureMessage(results)}`);
  }

  const [llmsText, officialText] = results.map((result) => result.value);
  let official;
  try {
    official = JSON.parse(officialText);
  } catch (error) {
    throw new Error(
      `${endpoints.official}: malformed JSON (${error.message})`,
    );
  }
  validateLiveTruth({ official, llmsText });
  return { valid: true };
};

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    const result = await checkLiveTruth({
      requireNetwork: process.env.REQUIRE_LIVE_TRUTH === "1",
    });
    console.log(
      result.skipped
        ? result.notice
        : "Live truth check passed for llms.txt, /api/official, and the /api/me rejection message.",
    );
  } catch (error) {
    console.error(`Live truth check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
