import { hiddenToastActionProps, threadToast } from "./toast-actions";
import { assert, describe, it } from "vite-plus/test";

describe("hiddenToastActionProps", () => {
  it("is a defined update payload so Base UI can replace a previous action", () => {
    assert.equal(hiddenToastActionProps.children, null);
    assert.equal("actionProps" in threadToast({ type: "loading", title: "Updating" }), false);
    assert.deepEqual(
      threadToast({
        actionProps: hiddenToastActionProps,
        title: "Updating",
        type: "loading",
      }).actionProps,
      hiddenToastActionProps,
    );
  });
});
