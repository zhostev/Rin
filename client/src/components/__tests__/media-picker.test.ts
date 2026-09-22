import { describe, expect, it } from "bun:test";
import { setPickedNote, togglePickedAsset, type PickedAsset } from "../media-picker";

describe("togglePickedAsset", () => {
  it("appends a newly picked asset with an empty note", () => {
    expect(togglePickedAsset([], "a")).toEqual([{ id: "a", note: "" }]);
  });

  it("removes an asset that was already picked", () => {
    expect(togglePickedAsset([{ id: "a", note: "n" }], "a")).toEqual([]);
  });

  it("keeps the order the admin picked in, since it is the order shown to the model", () => {
    const picked = togglePickedAsset(togglePickedAsset([], "a"), "b");
    expect(picked.map((asset) => asset.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const original: PickedAsset[] = [{ id: "a", note: "n" }];
    togglePickedAsset(original, "b");
    expect(original).toEqual([{ id: "a", note: "n" }]);
  });
});

describe("setPickedNote", () => {
  it("updates only the matching asset", () => {
    const picked: PickedAsset[] = [
      { id: "a", note: "" },
      { id: "b", note: "" },
    ];

    expect(setPickedNote(picked, "b", "说明")).toEqual([
      { id: "a", note: "" },
      { id: "b", note: "说明" },
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const picked: PickedAsset[] = [{ id: "a", note: "" }];
    expect(setPickedNote(picked, "zzz", "说明")).toEqual(picked);
  });

  it("does not mutate the input array", () => {
    const original: PickedAsset[] = [{ id: "a", note: "" }];
    setPickedNote(original, "a", "说明");
    expect(original).toEqual([{ id: "a", note: "" }]);
  });
});
