import { ExportDialog } from "@/components/export-dialog";
import { streamTableToFile } from "@/lib/export-table";
import { writeInMemory } from "@/lib/export";
import { useExport } from "@/state/export-state";

/** Mounted once at the root — routes to memory or stream based on the request. */
export function GlobalExportDialog() {
  const request = useExport((s) => s.request);
  const close = useExport((s) => s.close);
  if (!request) return null;

  if (request.mode === "memory") {
    return (
      <ExportDialog
        open={true}
        onClose={close}
        columns={request.columns}
        defaultName={request.defaultName}
        rowCount={request.rows.length}
        onExport={async ({ format, columns, path }) => {
          // Filter columns and rows in memory.
          const keep: number[] = [];
          for (let i = 0; i < request.columns.length; i++) {
            if (columns.includes(request.columns[i])) keep.push(i);
          }
          const sliced = request.rows.map((r) => keep.map((i) => r[i]));
          await writeInMemory(path, format, columns, sliced);
        }}
      />
    );
  }

  // mode === "stream"
  const ctx = request.streamContext;
  return (
    <ExportDialog
      open={true}
      onClose={close}
      columns={request.columns}
      defaultName={request.defaultName}
      onExport={async ({ format, columns, path }, setProgress) => {
        await streamTableToFile(
          ctx.connectionId,
          ctx.schema,
          ctx.table,
          columns,
          format,
          path,
          setProgress,
        );
      }}
    />
  );
}
