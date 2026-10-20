/* oxlint-disable react/no-array-index-key -- Table rows and columns have stable positions and may contain identical values. */

import { FileSurfaceNotice } from "./fileSurfaceChrome";
import { parseDelimitedPreview } from "@kora/shared/previewDelimiters";
import { useMemo } from "react";

const delimitedTablePreviewCls1 = "min-w-full border-separate border-spacing-0 text-xs";

/** A bounded, readable table for CSV and TSV text; the source view keeps every byte. */
export function DelimitedTablePreview(props: {
  readonly delimiter: "," | "\t";
  readonly text: string;
  readonly name: string;
}) {
  const { delimiter, text } = props;
  const table = useMemo(() => parseDelimitedPreview(text, delimiter), [text, delimiter]);
  const [header, ...body] = table.rows;
  const fileSurfaceNoticeBlock = table.truncated ? (
    <FileSurfaceNotice>
      Showing the first 100 rows × 30 columns. The source view has everything.
    </FileSurfaceNotice>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {fileSurfaceNoticeBlock}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className={delimitedTablePreviewCls1} aria-label={props.name}>
          {header ? (
            <thead className="sticky top-0 z-10">
              <tr>
                {header.map((cell, columnIndex) => (
                  <th
                    className="max-w-80 border-b border-border bg-muted/60 px-3 py-1.5 text-left align-bottom font-medium whitespace-pre-wrap break-words backdrop-blur"
                    key={columnIndex}
                    scope="col"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr className="even:bg-muted/30" key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td
                    className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                    key={columnIndex}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
