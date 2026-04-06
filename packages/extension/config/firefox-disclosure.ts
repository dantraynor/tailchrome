export interface FirefoxDataCollectionPermissions {
  required: readonly string[];
  optional?: readonly string[];
}

export type FirefoxDisclosure =
  | {
      status: "todo";
      note: string;
    }
  | {
      status: "ready";
      dataCollectionPermissions: FirefoxDataCollectionPermissions;
    };

export const firefoxDisclosure: FirefoxDisclosure = {
  status: "ready",
  dataCollectionPermissions: {
    // Tailchrome only proxies traffic after the user enables the helper and
    // signs in, but Firefox still requires a conservative disclosure because
    // extension-managed browsing activity is transmitted through the local
    // native messaging helper for routing onto the user's tailnet.
    required: ["browsingActivity", "websiteContent"],
    optional: [],
  },
};

export function isFirefoxDisclosureReady(
  disclosure: FirefoxDisclosure,
): disclosure is Extract<FirefoxDisclosure, { status: "ready" }> {
  return disclosure.status === "ready";
}
