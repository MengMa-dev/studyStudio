/** A transport adapter for Electron/Tauri/main-process code. */
export function createLocalIngestionClient({ ingestionUrl = "http://127.0.0.1:43118", pairingToken }) {
  if (!pairingToken) throw new Error("A local ingestion pairing token is required.");
  const call = async (path, body) => {
    const response = await fetch(`${ingestionUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pairingToken}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Local ingestion rejected ${path}: ${response.status}`);
    return response.json();
  };
  return {
    sendEvent: (event) => call("/v1/events", event),
    lookupPage: (canonicalUrl) => call(`/v1/pages?canonicalUrl=${encodeURIComponent(canonicalUrl)}`)
  };
}
