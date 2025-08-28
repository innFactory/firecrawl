import { scrapeTimeout, idmux } from "./lib";
import { scrapeRaw, extract } from "./v1/lib";

describe("Schema validation for additionalProperties", () => {
  if (!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL) {
    describe("V1 API", () => {
      it("should reject scrape request with additionalProperties in extract schema", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await scrapeRaw({
          url: "https://example.com",
          formats: ["extract"],
          extract: {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" }
              },
              additionalProperties: false
            }
          }
        }, identity);

        expect(response.statusCode).toBe(400);
        expect(response.body.error).toContain("additionalProperties");
        expect(response.body.error).toContain("OpenAI");
      }, scrapeTimeout);

      it("should reject extract request with additionalProperties in schema", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        try {
          const response = await extract({
            urls: ["https://example.com"],
            schema: {
              type: "object",
              properties: {
                title: { type: "string" }
              },
              additionalProperties: true
            }
          }, identity);
          
          expect(response.success).toBe(false);
          expect(response.error).toContain("additionalProperties");
          expect(response.error).toContain("OpenAI");
        } catch (error) {
          expect(error.message).toContain("additionalProperties");
          expect(error.message).toContain("OpenAI");
        }
      }, scrapeTimeout);

      it("should reject scrape request with nested additionalProperties", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await scrapeRaw({
          url: "https://example.com",
          formats: ["extract"],
          extract: {
            schema: {
              type: "object",
              properties: {
                user: {
                  type: "object",
                  properties: {
                    name: { type: "string" }
                  },
                  additionalProperties: false
                }
              }
            }
          }
        }, identity);

        expect(response.statusCode).toBe(400);
        expect(response.body.error).toContain("additionalProperties");
        expect(response.body.error).toContain("OpenAI");
      }, scrapeTimeout);

      it("should accept valid schema without additionalProperties", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await scrapeRaw({
          url: "https://example.com",
          formats: ["extract"],
          extract: {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" }
              },
              required: ["title"]
            }
          }
        }, identity);

        expect(response.statusCode).toBe(200);
      }, scrapeTimeout);

      it("should reject changeTracking with additionalProperties in schema", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await scrapeRaw({
          url: "https://example.com",
          formats: ["markdown", "changeTracking"],
          changeTrackingOptions: {
            schema: {
              type: "object",
              properties: {
                changes: { type: "string" }
              },
              additionalProperties: true
            }
          }
        }, identity);

        expect(response.statusCode).toBe(400);
        expect(response.body.error).toContain("additionalProperties");
        expect(response.body.error).toContain("OpenAI");
      }, scrapeTimeout);
    });

    describe("V2 API", () => {
      it("should reject scrape request with additionalProperties in json format schema", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await fetch(`${process.env.TEST_URL}/v2/scrape`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${identity.apiKey}`
          },
          body: JSON.stringify({
            url: "https://example.com",
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" }
                  },
                  additionalProperties: false
                }
              }
            ]
          })
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain("additionalProperties");
        expect(data.error).toContain("OpenAI");
      }, scrapeTimeout);

      it("should reject extract request with additionalProperties in schema", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await fetch(`${process.env.TEST_URL}/v2/extract`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${identity.apiKey}`
          },
          body: JSON.stringify({
            urls: ["https://example.com"],
            schema: {
              type: "object",
              properties: {
                title: { type: "string" }
              },
              additionalProperties: true
            }
          })
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain("additionalProperties");
        expect(data.error).toContain("OpenAI");
      }, scrapeTimeout);

      it("should reject changeTracking format with additionalProperties", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await fetch(`${process.env.TEST_URL}/v2/scrape`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${identity.apiKey}`
          },
          body: JSON.stringify({
            url: "https://example.com",
            formats: [
              { type: "markdown" },
              {
                type: "changeTracking",
                schema: {
                  type: "object",
                  properties: {
                    changes: { type: "string" }
                  },
                  additionalProperties: false
                }
              }
            ]
          })
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain("additionalProperties");
        expect(data.error).toContain("OpenAI");
      }, scrapeTimeout);

      it("should accept valid schema without additionalProperties", async () => {
        const identity = await idmux({ name: "schema-validation-test" });
        
        const response = await fetch(`${process.env.TEST_URL}/v2/scrape`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${identity.apiKey}`
          },
          body: JSON.stringify({
            url: "https://example.com",
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" }
                  },
                  required: ["title"]
                }
              }
            ]
          })
        });

        expect(response.status).toBe(200);
      }, scrapeTimeout);
    });
  }
});
