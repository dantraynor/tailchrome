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
    required: ["none"],
    optional: [],
  },
};

export function isFirefoxDisclosureReady(
  disclosure: FirefoxDisclosure,
): disclosure is Extract<FirefoxDisclosure, { status: "ready" }> {
  return disclosure.status === "ready";
}
