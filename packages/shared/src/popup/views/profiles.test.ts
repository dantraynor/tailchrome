// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseState } from "../../__test__/fixtures";
import { sendMessage } from "../popup";
import { renderProfiles } from "./profiles";

vi.mock("../popup", () => ({ sendMessage: vi.fn() }));

describe("profiles view", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
  });

  it("leaves the switcher after starting a new profile", () => {
    const root = document.createElement("div");
    const onBack = vi.fn();
    renderProfiles(
      root,
      baseState({
        currentProfile: { id: "personal", name: "Personal" },
        profiles: [{ id: "personal", name: "Personal" }],
      }),
      onBack,
    );

    root.querySelector<HTMLButtonElement>(".profile-add-row button")!.click();

    expect(sendMessage).toHaveBeenCalledWith({ type: "new-profile" });
    expect(onBack).toHaveBeenCalledOnce();
  });
});
