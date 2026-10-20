import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { SheetTable } from "./SheetTable";

describe("SheetTable", () => {
  it("renders cells without a React key warning (plv S3-4)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      act(() => {
        create(
          <SheetTable
            model={{
              header: ["A", "B"],
              rows: [
                ["1", "2"],
                ["3", "4"],
              ],
              formulas: [["", "=A1*2"]],
              totalRows: 2,
              moreRows: false,
              moreCols: false,
            }}
            rowLimit={10}
            colLimit={10}
          />,
        );
      });
      const keyWarnings = error.mock.calls.filter((c) => String(c[0]).includes('unique "key"'));
      expect(keyWarnings).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});
