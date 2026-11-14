import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useStore } from '../core/store';

interface Props { children: ReactNode; /** 'app' fills the screen; 'area' replaces just one panel or pane. */ scope?: 'app' | 'area'; label?: string }
interface State { error: Error | null; info: string; copied: boolean }

const copyText = async (s: string) => { try { await navigator.clipboard.writeText(s); return true; } catch { return false; } };

/** Catches a crash and offers a way back instead of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '', copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { this.setState({ info: info.componentStack ?? '' }); console.error(error); }

  private reset = () => this.setState({ error: null, info: '', copied: false });
  private undo = () => { useStore.getState().undo(); this.reset(); };
  private copy = async () => {
    const e = this.state.error;
    const ok = await copyText(`${e?.name}: ${e?.message}\n${e?.stack ?? ''}\n${this.state.info}`);
    this.setState({ copied: ok });
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const canUndo = useStore.getState().past.length > 0;
    const area = this.props.scope === 'area';
    return (
      <div className={area ? 'crash crash-area' : 'crash crash-app'} role="alert">
        <div className="crash-card">
          <h2>{area ? `${this.props.label ?? 'This part'} stopped working` : 'Something broke'}</h2>
          <p>Your plan is saved on this device.</p>
          <div className="crash-actions">
            {canUndo
              ? <button type="button" className="btn btn-primary" onClick={this.undo}>Undo last change</button>
              : <button type="button" className="btn btn-primary" onClick={this.reset}>Try again</button>}
            <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
            <button type="button" className="btn btn-ghost" onClick={this.copy}>{copied ? 'Copied' : 'Copy details'}</button>
          </div>
        </div>
      </div>
    );
  }
}
