import assert from "node:assert/strict";
import test from "node:test";
import { lookupViaNummerpladeApi, SourceError } from "./nummerplade-api.js";

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("samler køretøj, DMR og Bilbogen uden at returnere debitor", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/dmr/registration/AB12345")) {
      return jsonResponse({ data: {
        insurance_company: "TRYG FORSIKRING A/S",
        insurance_status: "Aktiv",
        insurance_created: "04-04-2019",
      } });
    }
    if (url.includes("/tinglysning/TESTVIN1234567890")) {
      return jsonResponse({
        liabilities: [
          {
            amount: 100000,
            creditors: [{ name: "NORDISK FINANS A/S", cvr: 12345678 }],
            debtors: [{ name: "Skal filtreres", dateOfBirth: "1970-01-01" }],
          },
          {
            amount: 74000,
            creditors: [{ name: "NORDISK FINANS A/S", cvr: 12345678 }],
          },
        ],
        notices: [],
      });
    }
    if (url.includes("/debt/9001")) {
      return jsonResponse({ data: {
        no_debt: false,
        amount: 174000,
        debtors: [{ name: "Skal filtreres", cpr: "0101700000" }],
        creditors: [{ name: "NORDISK FINANS A/S", cvr: 12345678 }],
      } });
    }
    return jsonResponse({ data: {
      registration: "AB12345",
      vin: "TESTVIN1234567890",
      type: "Personbil",
      brand: "VOLKSWAGEN",
      model: "GOLF",
      version: "1.5 TSI",
      registration_status: "Registreret",
      first_registration_date: "2019-08-12",
      vehicle_id: 9001,
    } });
  };

  try {
    const result = await lookupViaNummerpladeApi("AB 12 345", "test-token", 1000);
    assert.equal(result.insurance.status, "Aktiv");
    assert.equal(result.liens.count, 2);
    assert.equal(result.liens.totalAmount, 174000);
    assert.deepEqual(result.liens.creditors, [{ name: "NORDISK FINANS A/S", cvr: "12345678" }]);
    assert.equal("debtors" in result.liens, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("afviser opslag uden server-token", async () => {
  await assert.rejects(
    () => lookupViaNummerpladeApi("AB12345", undefined, 1000),
    (error: unknown) => error instanceof SourceError && error.code === "NOT_CONFIGURED",
  );
});
