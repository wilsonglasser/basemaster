import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Clipboard,
  ClipboardCopy,
  ClipboardPaste,
  Play,
  Scissors,
  TextCursorInput,
  Wand2,
} from "lucide-react";

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  copyLineDown,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { MySQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import { useContextMenu, type ContextEntry } from "@/hooks/use-context-menu";
import { aliasCompletionSource } from "@/lib/sql-alias-completion";
import { useT } from "@/state/i18n";
import { useTheme } from "@/state/theme";

interface QueryEditorProps {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  /** Run only the statement covering the given cursor offset. */
  onRunStatement?: (cursor: number) => void;
  /** Triggered by Ctrl+Shift+F or context menu Format. */
  onFormat?: () => void;
  schema: SQLNamespace;
  defaultSchema?: string;
  /** Lowercase table-name → column names. Powers `alias.col` autocomplete
   *  by resolving aliases against the FROM/JOIN clauses of the current
   *  statement and looking up columns here. */
  tableColumns?: Record<string, string[]>;
}

export interface QueryEditorHandle {
  getCursor(): number;
  focus(): void;
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.55",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--muted-foreground)",
  },
  ".cm-activeLineGutter, .cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--muted-foreground) 8%, transparent)",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--foreground)",
  },
});

export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(
  function QueryEditor(
    {
      value,
      onChange,
      onRun,
      onRunStatement,
      onFormat,
      schema,
      defaultSchema,
      tableColumns,
    },
    forwardedRef,
  ) {
    const t = useT();
    const ref = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onRunRef = useRef(onRun);
    const onRunStatementRef = useRef(onRunStatement);
    const onChangeRef = useRef(onChange);
    const onFormatRef = useRef(onFormat);
    const sqlCompartment = useRef(new Compartment());
    const themeCompartment = useRef(new Compartment());
    const cmTheme = useTheme((s) => s.effectivePreset().cmTheme);
    const tableColumnsRef = useRef<Record<string, string[]>>(
      tableColumns ?? {},
    );

    useEffect(() => {
      onRunRef.current = onRun;
      onRunStatementRef.current = onRunStatement;
      onChangeRef.current = onChange;
      onFormatRef.current = onFormat;
      tableColumnsRef.current = tableColumns ?? {};
    });

    // Build the SQL language extension + the alias-aware autocomplete
    // source attached to that language scope. Recomputed in the reconfigure
    // effect when schema/defaultSchema changes.
    const buildSqlExt = () => {
      const base = sql({
        dialect: MySQL,
        schema,
        defaultSchema,
        upperCaseKeywords: true,
      });
      const aliasExt = base.language.data.of({
        autocomplete: aliasCompletionSource(
          (table) => tableColumnsRef.current?.[table],
        ),
      });
      return [base, aliasExt];
    };

    useImperativeHandle(forwardedRef, () => ({
      getCursor() {
        const view = viewRef.current;
        if (!view) return 0;
        return view.state.selection.main.head;
      },
      focus() {
        viewRef.current?.focus();
      },
    }));

    useEffect(() => {
      if (!ref.current) return;

      const state = EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          autocompletion(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          sqlCompartment.current.of(buildSqlExt()),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...searchKeymap,
            indentWithTab,
            {
              key: "Mod-Shift-Enter",
              preventDefault: true,
              run: (v) => {
                if (!onRunStatementRef.current) return false;
                onRunStatementRef.current(v.state.selection.main.head);
                return true;
              },
            },
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                onRunRef.current();
                return true;
              },
            },
            {
              key: "Mod-Shift-f",
              preventDefault: true,
              run: () => {
                onFormatRef.current?.();
                return true;
              },
            },
            {
              key: "Mod-d",
              preventDefault: true,
              run: copyLineDown,
            },
          ]),
          themeCompartment.current.of(cmTheme),
          editorTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      });

      const view = new EditorView({ state, parent: ref.current });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: sqlCompartment.current.reconfigure(buildSqlExt()),
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [schema, defaultSchema]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartment.current.reconfigure(cmTheme),
      });
    }, [cmTheme]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current !== value) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: value },
        });
      }
    }, [value]);

    const selectAll = () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        selection: EditorSelection.single(0, view.state.doc.length),
      });
      view.focus();
    };

    const getSelectedText = (): string => {
      const view = viewRef.current;
      if (!view) return "";
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    };

    const replaceSelection = (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    };

    const doCopy = async () => {
      const text = getSelectedText();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        console.warn("clipboard.writeText:", e);
      }
    };

    const doCut = async () => {
      const text = getSelectedText();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        console.warn("clipboard.writeText:", e);
      }
      replaceSelection("");
    };

    const doPaste = async () => {
      try {
        const text = await navigator.clipboard.readText();
        replaceSelection(text);
      } catch (e) {
        console.warn("clipboard.readText:", e);
      }
    };

    const [ctxItems, setCtxItems] = useState<ContextEntry[]>([]);
    const ctxMenu = useContextMenu(ctxItems);

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const hasSelection = getSelectedText().length > 0;
      const items: ContextEntry[] = [];
      if (onRunStatement) {
        items.push({
          icon: <TextCursorInput className="h-3.5 w-3.5" />,
          label: t("query.contextRunStatement"),
          shortcut: "Ctrl+Shift+↵",
          onClick: () => {
            const view = viewRef.current;
            if (!view) return;
            onRunStatementRef.current?.(view.state.selection.main.head);
          },
        });
      }
      items.push({
        icon: <Play className="h-3.5 w-3.5" />,
        label: t("query.contextRun"),
        shortcut: "Ctrl+↵",
        onClick: () => onRunRef.current(),
      });
      if (onFormat) {
        items.push({
          icon: <Wand2 className="h-3.5 w-3.5" />,
          label: t("query.contextFormat"),
          shortcut: "Ctrl+Shift+F",
          onClick: () => onFormatRef.current?.(),
        });
      }
      items.push({ separator: true });
      items.push({
        icon: <Scissors className="h-3.5 w-3.5" />,
        label: t("query.contextCut"),
        shortcut: "Ctrl+X",
        disabled: !hasSelection,
        onClick: () => void doCut(),
      });
      items.push({
        icon: <ClipboardCopy className="h-3.5 w-3.5" />,
        label: t("query.contextCopy"),
        shortcut: "Ctrl+C",
        disabled: !hasSelection,
        onClick: () => void doCopy(),
      });
      items.push({
        icon: <ClipboardPaste className="h-3.5 w-3.5" />,
        label: t("query.contextPaste"),
        shortcut: "Ctrl+V",
        onClick: () => void doPaste(),
      });
      items.push({ separator: true });
      items.push({
        icon: <Clipboard className="h-3.5 w-3.5" />,
        label: t("query.contextSelectAll"),
        shortcut: "Ctrl+A",
        onClick: selectAll,
      });
      setCtxItems(items);
      ctxMenu.openAt(e);
    };

    return (
      <div
        ref={ref}
        className="h-full w-full overflow-hidden"
        onContextMenu={handleContextMenu}
      >
        {ctxMenu.element}
      </div>
    );
  },
);
