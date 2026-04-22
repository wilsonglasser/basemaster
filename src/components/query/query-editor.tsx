import { useEffect, useRef } from "react";

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { MySQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import { useTheme } from "@/state/theme";

interface QueryEditorProps {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  /** Opcional — disparado por Ctrl+Shift+F. */
  onFormat?: () => void;
  schema: SQLNamespace;
  defaultSchema?: string;
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

export function QueryEditor({
  value,
  onChange,
  onRun,
  onFormat,
  schema,
  defaultSchema,
}: QueryEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  const onFormatRef = useRef(onFormat);
  const sqlCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const cmTheme = useTheme((s) => s.effectivePreset().cmTheme);

  // Mantém callbacks atuais sem recriar o editor.
  useEffect(() => {
    onRunRef.current = onRun;
    onChangeRef.current = onChange;
    onFormatRef.current = onFormat;
  });

  // Setup uma vez por montagem.
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
        sqlCompartment.current.of(
          sql({
            dialect: MySQL,
            schema,
            defaultSchema,
            upperCaseKeywords: true,
          }),
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...searchKeymap,
          indentWithTab,
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

  // Reconfigura o SQL extension quando o schema/defaultSchema muda.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: sqlCompartment.current.reconfigure(
        sql({
          dialect: MySQL,
          schema,
          defaultSchema,
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [schema, defaultSchema]);

  // Troca o theme do CodeMirror quando o preset do app muda.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(cmTheme),
    });
  }, [cmTheme]);

  // Sincroniza valor externo (apenas se realmente diferiu — evita loop).
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

  return <div ref={ref} className="h-full w-full overflow-hidden" />;
}
