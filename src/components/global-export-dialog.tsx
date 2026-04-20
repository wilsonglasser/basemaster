import { ExportDialog } from "@/components/export-dialog";
import { streamTableToFile } from "@/lib/export-table";
import { writeInMemory } from "@/lib/export";
import { useExport } from "@/state/export-state";

/** Montado uma vez no root — roteia pra memory ou stream conforme request. */
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
          // Filtra colunas e linhas em memória.
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
