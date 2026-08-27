import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const endpoints = {
  llms: "https://1f3ea.com/llms.txt",
  official: "https://1f3ea.com/api/official",
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

export const validateLiveTruth = ({ official, llmsText }) => {
  requireClaim(
    official && typeof official === "object",
    "/api/official must return a JSON object",
  );
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

  const pagination = compact(
    String(official.public_pagination?.completeness ?? ""),
  );
  requireClaim(
    /^every bounded collection reports an exact total.{0,100}returned count.{0,80}page size.{0,80}has_more.{0,100}continuation cursor[.;]\s*(?:a )?null continuation means (?:the )?response is complete/iu.test(
      pagination,
    ),
    "/api/official pagination completeness promise changed",
  );

  const normalizedLlms = compact(llmsText);
  requireClaim(
    /(?:^|[.!?]\s+|-\s+)listings? (?:cost|costs) \$1(?:\.0+)? USDC on Base\s+(?:via|through)\s+x402/iu.test(
      normalizedLlms,
    ),
    "llms.txt must name the 1 USDC Base x402 listing fee",
  );
  requireClaim(
    /(?:^|[.!?]\s+|-\s+)start every visit\s+(?:through|with)\s+(?:(?:an?|the)\s+)?(?:available\s+)?connector\s*:\s*call front_door first\s*,?\s*then official_facts/iu.test(
      normalizedLlms,
    ) &&
      /(?:^|[.!?]\s+)(?:the )?front[- ]door fallback is https:\/\/1f3ea\.com\/ if (?:your )?client can open URLs/iu.test(
        normalizedLlms,
      ),
    "connector-first opening must keep front_door, official_facts, then the URL-capable fallback",
  );
  requireClaim(
    /(?:^|[.!?]\s+|-\s+)a 502 means(?:(?!\s-\s)[\s\S]){0,260}facilitator rejected(?:(?!\s-\s)[\s\S]){0,220}without (?:(?!\s-\s)[\s\S]){0,100}(?:identifying|saying)(?:(?!\s-\s)[\s\S]){0,100}whether(?:(?!\s-\s)[\s\S]){0,140}proof(?:(?!\s-\s)[\s\S]){0,180}requirements(?:(?!\s-\s)[\s\S]){0,180}facilitator handling(?:(?!\s-\s)[\s\S]){0,120}at fault(?:(?!\s-\s)[\s\S]){0,220}do not (?:replace or replay|retry or replay)(?:(?!\s-\s)[\s\S]){0,100}blindly/iu.test(
      normalizedLlms,
    ),
    "502 must preserve ambiguous-blame and no-blind-proof-replay guidance",
  );
  requireClaim(
    /(?:^|[.!?]\s+|-\s+)a 503 means(?:(?!\s-\s)[\s\S]){0,260}verification is unavailable(?:(?!\s-\s)[\s\S]){0,360}[.;]\s*retry the same proof(?:(?!\s-\s)[\s\S]){0,100}do not pay again/iu.test(
      normalizedLlms,
    ),
    "503 must preserve unavailable-verification, same-proof, and no-second-payment guidance",
  );
  requireClaim(
    /(?:^|[.!?]\s+|-\s+)a pending or duplicate settlement is 503[.;]\s*retry the same proof(?:(?!\s-\s)[\s\S]){0,100}do not pay again/iu.test(
      normalizedLlms,
    ),
    "pending or duplicate settlement must remain 503 with safe same-proof retry",
  );
  requireClaim(
    /(?:^|[.!?]\s+|-\s+)every bounded collection reports an exact total.{0,140}has_more.{0,120}(?:continuation )?cursor.{0,180}has_more=false\s*,?\s+and\s+(?:a )?null cursor means (?:that )?(?:view|response) is complete/iu.test(
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
  ]);
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    const bothUnavailable =
      failures.length === 2 &&
      failures.every(
        (result) => result.reason instanceof FetchUnavailableError,
      );
    if (bothUnavailable && !requireNetwork) {
      return {
        skipped: true,
        notice: `SKIP live truth: ${endpoints.llms} and ${endpoints.official} are offline (${failureMessage(results)})`,
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
        : "Live truth check passed for llms.txt and /api/official.",
    );
  } catch (error) {
    console.error(`Live truth check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
