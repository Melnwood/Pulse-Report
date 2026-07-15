// Serverless proxy to the Anthropic API. Keeps the API key server-side so it
// never ships in the browser bundle. Reads the key from the ANTHROPIC_KEY env var.
exports.handler = async (event) => {
  // CORS / preflight safety
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed. Use POST." }) };
  }

  const key = process.env.ANTHROPIC_KEY;
  if (!key) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_KEY env var is not set on this deploy." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Request body was not valid JSON: " + e.message }) };
  }

  try {
    // Node 18+ on Netlify has global fetch. Fall back to node-fetch only if absent.
    const doFetch = (typeof fetch !== "undefined")
      ? fetch
      : (await import("node-fetch")).default;

    const response = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    return {
      statusCode: response.status,
      headers,
      body: text, // pass through Anthropic's response (JSON) verbatim
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Proxy failed to reach Anthropic: " + err.message }) };
  }
};
