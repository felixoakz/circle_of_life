// Analytics (self-hosted Umami at stats.fx-labs.tech, as on the portfolio):
// the script tag in index.html counts page views on the live domain only
// (`data-domains`), with no cookies. This sends the few custom events worth
// knowing: a search pick, free view switched on, Data & credits opened. A
// no-op when the script did not load (blockers, local dev, tests).

type Umami = { track: (event: string, data?: Record<string, string>) => void };

/** Sends `event` with optional string data, if the Umami script is there. */
export function track(event: string, data?: Record<string, string>): void {
  (window as { umami?: Umami }).umami?.track(event, data);
}
