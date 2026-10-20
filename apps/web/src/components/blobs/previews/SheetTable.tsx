// A real table for a sheet or a CSV: sticky header, numbers right-aligned, long cells truncated (full text on hover),
// and an honest footer whenever the preview shows less than the file holds.
import { Hint } from "~/components/ui/hint";
import { cn } from "~/util/utils";

export interface TableModel {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** Row numbers shown in the gutter (sheets are sparse); omitted for CSV, which counts 1..n. */
  readonly rowNumbers?: ReadonlyArray<number>;
  /** Formula text per cell (same shape as `rows`), shown on hover. */
  readonly formulas?: ReadonlyArray<ReadonlyArray<string>>;
  readonly totalRows: number | null;
  readonly moreRows: boolean;
  readonly moreCols: boolean;
  /** CSV text was cut at the read cap, so totals are a lower bound. */
  readonly textTruncated?: boolean;
}

const NUMERIC = /^[-+]?[$€£]?\d[\d,]*(?:\.\d+)?%?$/;

export function tableFooter(model: TableModel, shownRows: number): string | null {
  const parts: string[] = [];
  const total = model.totalRows;
  if (model.moreRows || shownRows < model.rows.length) {
    const of =
      total !== null ? ` of ${total.toLocaleString("en-US")}${model.textTruncated ? "+" : ""}` : "";
    parts.push(`Showing the first ${shownRows.toLocaleString("en-US")}${of} rows`);
  } else if (model.textTruncated) {
    parts.push(
      `Showing ${shownRows.toLocaleString("en-US")} rows; the file is longer than the preview reads`,
    );
  }
  if (model.moreCols) parts.push("more columns not shown");
  return parts.length > 0 ? `${parts.join(" · ")}. Open the file for everything.` : null;
}

export function SheetTable(props: {
  readonly model: TableModel;
  /** Rows / columns to render (the chat card shows a handful; expanded shows everything the preview read). */
  readonly rowLimit: number;
  readonly colLimit: number;
  readonly gutter?: boolean;
  readonly className?: string;
}) {
  const { model } = props;
  const shown = model.rows.slice(0, props.rowLimit);
  const colCount = Math.min(
    props.colLimit,
    Math.max(model.header.length, ...shown.map((row) => row.length), 1),
  );
  const cols = Array.from({ length: colCount }, (_, index) => index);
  const hiddenByCard = model.rows.length > shown.length;
  const footer = tableFooter(
    { ...model, moreRows: model.moreRows || hiddenByCard },
    hiddenByCard ? shown.length : model.rows.length,
  );
  return (
    <div className={cn("min-w-0", props.className)} data-sheet-table>
      <table className="w-full border-separate border-spacing-0 text-[12px] leading-5">
        <thead>
          <tr>
            {props.gutter ? (
              <th className="sticky top-0 z-10 w-8 border-b border-border/60 bg-card px-2 py-1 text-right font-normal text-muted-foreground/60" />
            ) : null}
            {cols.map((col) => (
              <th
                key={col}
                scope="col"
                className="sticky top-0 z-10 max-w-[16rem] truncate border-b border-border/60 bg-card px-2.5 py-1 text-left font-medium text-foreground"
              >
                {model.header[col] ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-foreground/[0.02]">
              {props.gutter ? (
                <td className="w-8 px-2 py-0.5 text-right tabular-nums text-muted-foreground/50">
                  {model.rowNumbers?.[rowIndex] ?? rowIndex + 2}
                </td>
              ) : null}
              {cols.map((col) => {
                const value = row[col] ?? "";
                const formula = model.formulas?.[rowIndex]?.[col] || undefined;
                return (
                  <Hint key={col} label={formula}>
                    <td
                      className={cn(
                        "max-w-[16rem] truncate px-2.5 py-0.5 text-foreground/85",
                        NUMERIC.test(value) && "text-right tabular-nums",
                      )}
                    >
                      {value}
                    </td>
                  </Hint>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {footer ? (
        <p className="px-2.5 py-1.5 text-[11.5px] text-muted-foreground" data-sheet-footer>
          {footer}
        </p>
      ) : null}
    </div>
  );
}

/** A sheet's rows as a table model: the first rendered row is the header. */
export function tableModelFromSheet(sheet: {
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly rowNumbers: ReadonlyArray<number>;
  readonly formulas?: ReadonlyArray<ReadonlyArray<string>>;
  readonly totalRows: number | null;
  readonly moreRows: boolean;
  readonly moreCols: boolean;
}): TableModel {
  const [header = [], ...rows] = sheet.rows;
  return {
    header,
    rows,
    rowNumbers: sheet.rowNumbers.slice(1),
    ...(sheet.formulas ? { formulas: sheet.formulas.slice(1) } : {}),
    totalRows: sheet.totalRows !== null ? Math.max(0, sheet.totalRows - 1) : null,
    moreRows: sheet.moreRows,
    moreCols: sheet.moreCols,
  };
}
