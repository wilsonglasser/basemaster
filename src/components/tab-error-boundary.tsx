import React from "react";

interface State {
  error: Error | null;
}

/**
 * Error boundary por aba. Sem isso, um erro em qualquer componente filho
 * derruba toda a árvore React e o usuário vê tela preta. Aqui exibimos
 * o stack trace localizado na própria aba — o resto do app continua vivo.
 */
export class TabErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[tab error]", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="h-full overflow-auto p-6">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
            <div className="mb-2 text-sm font-semibold text-destructive">
              Erro na aba
            </div>
            <pre className="mb-3 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-destructive/90">
              {this.state.error.message}
              {"\n\n"}
              {this.state.error.stack}
            </pre>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md border border-border bg-background px-3 py-1 text-xs hover:bg-accent"
            >
              Tentar de novo
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
