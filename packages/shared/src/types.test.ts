import { describe, it, expectTypeOf } from "vitest";
import type { BackgroundMessage } from "./types";

describe("BackgroundMessage set-pref typing", () => {
  it("accepts boolean value for boolean pref keys", () => {
    const msg: BackgroundMessage = {
      type: "set-pref",
      key: "shieldsUp",
      value: true,
    };
    expectTypeOf(msg).toMatchTypeOf<BackgroundMessage>();
  });

  it("accepts string value for string pref keys", () => {
    const msg: BackgroundMessage = {
      type: "set-pref",
      key: "exitNodeID",
      value: "some-node-id",
    };
    expectTypeOf(msg).toMatchTypeOf<BackgroundMessage>();
  });

  it("rejects string value for boolean-only pref keys", () => {
    const _bad: BackgroundMessage = {
      type: "set-pref",
      key: "shieldsUp",
      // @ts-expect-error shieldsUp requires boolean, not string
      value: "true",
    };
    void _bad;
  });

  it("rejects boolean value for string-only pref keys", () => {
    const _bad: BackgroundMessage = {
      type: "set-pref",
      key: "exitNodeID",
      // @ts-expect-error exitNodeID requires string, not boolean
      value: true,
    };
    void _bad;
  });
});
