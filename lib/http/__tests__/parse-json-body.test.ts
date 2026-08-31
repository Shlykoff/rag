import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody } from "../parse-json-body";

const Schema = z.object({ name: z.string().min(1) });

function makeRequest(body: string): Request {
  return new Request("http://localhost/api/whatever", { method: "POST", body });
}

describe("parseJsonBody", () => {
  it("returns the validated data for a well-formed body matching the schema", async () => {
    const result = await parseJsonBody(makeRequest(JSON.stringify({ name: "hi" })), Schema);
    expect("data" in result).toBe(true);
    if ("data" in result) expect(result.data).toEqual({ name: "hi" });
  });

  it("returns a 400 { error: 'invalid_request' } Response for malformed JSON", async () => {
    const result = await parseJsonBody(makeRequest("not json at all"), Schema);
    expect("errorResponse" in result).toBe(true);
    if ("errorResponse" in result) {
      expect(result.errorResponse.status).toBe(400);
      expect(await result.errorResponse.json()).toEqual({
        error: "invalid_request",
        details: "Body must be valid JSON.",
      });
    }
  });

  it("returns a 400 { error: 'invalid_request', details: <flattened zod errors> } for JSON that fails the schema", async () => {
    const result = await parseJsonBody(makeRequest(JSON.stringify({ name: "" })), Schema);
    expect("errorResponse" in result).toBe(true);
    if ("errorResponse" in result) {
      expect(result.errorResponse.status).toBe(400);
      const body = (await result.errorResponse.json()) as { error: string; details: unknown };
      expect(body.error).toBe("invalid_request");
      expect(body.details).toBeTruthy();
    }
  });
});
