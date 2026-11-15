// The hands-free conversation: listen, end the utterance after a pause, run the turn, speak,
// listen again. The person can always cut the voice off. Everything outside is injected so the
// state machine runs under fake timers.

export type ConvState = 'off' | 'listening' | 'thinking' | 'speaking';

export const SILENCE_MS = 900;
/** Words heard this soon after the voice stops still count as its echo. */
export const TAIL_MS = 1200;

export interface ConvDeps {
  ear: { start(): void; stop(): void; abort(): void };
  runTurn(text: string): Promise<void>;
  stopSpeaking(): void;
  isEcho(heard: string, spoken: string): boolean;
  /** Called before each turn, e.g. to clear the previous sketches. */
  beforeTurn?(): void;
  onState?(s: ConvState): void;
  /** Words to show as a caption. */
  onCaption?(text: string): void;
  now?(): number;
}

export class Conversation {
  state: ConvState = 'off';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finals: string[] = [];
  private interim = '';
  private speaking = false;
  private spoken = '';
  private spokeEnd = -Infinity;
  private busy = false;
  private paused = false;
  private gen = 0;
  constructor(private d: ConvDeps) {}

  get on() { return this.state !== 'off'; }

  private now() { return (this.d.now ?? Date.now)(); }
  private set(s: ConvState) { if (s !== this.state) { this.state = s; this.d.onState?.(s); } }
  private refresh() {
    if (this.state === 'off') return;
    this.set(this.speaking ? 'speaking' : this.busy ? 'thinking' : 'listening');
  }
  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private reset() { this.finals = []; this.interim = ''; this.d.onCaption?.(''); }

  start() {
    if (this.on) return;
    this.reset();
    this.set('listening');
    if (!this.paused) this.d.ear.start();
  }

  end() {
    if (!this.on) return;
    this.gen++;
    this.clearTimer();
    this.reset();
    this.d.ear.abort();
    this.d.stopSpeaking();
    this.busy = false;
    this.speaking = false;
    this.set('off');
  }

  /** Tab hidden: stop hearing; visible again: resume. */
  setPaused(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    if (!this.on) return;
    if (p) { this.clearTimer(); this.reset(); this.d.ear.abort(); } else this.d.ear.start();
  }

  /** The speech engine started or stopped talking. */
  setSpeaking(speaking: boolean, text = '') {
    if (speaking) { if (text) this.spoken = text; } else if (this.speaking) this.spokeEnd = this.now();
    this.speaking = speaking;
    this.refresh();
  }

  private echo(t: string) {
    const recent = this.speaking || this.now() - this.spokeEnd < TAIL_MS;
    return recent && this.d.isEcho(t, this.spoken);
  }

  private arm() {
    this.clearTimer();
    this.timer = setTimeout(() => this.commit(), SILENCE_MS);
  }

  /** Live words of the utterance in progress. */
  hearInterim(t: string) {
    if (!this.on || this.paused) return;
    const text = t.trim();
    if (!text || this.echo(text)) return;
    if (this.speaking) this.d.stopSpeaking(); // barge-in
    this.interim = text;
    this.d.onCaption?.([...this.finals, text].join(' '));
    this.arm();
  }

  /** A finished piece of speech. */
  hearFinal(t: string) {
    if (!this.on || this.paused) return;
    const text = t.trim();
    if (!text || this.echo(text)) return;
    if (this.speaking) this.d.stopSpeaking();
    this.finals.push(text);
    this.interim = '';
    this.d.onCaption?.(this.finals.join(' '));
    this.arm();
  }

  private commit() {
    this.timer = null;
    const text = [...this.finals, this.interim].join(' ').trim();
    this.finals = []; this.interim = '';
    if (!text || !this.on) return;
    const gen = ++this.gen;
    this.busy = true;
    this.d.beforeTurn?.();
    this.refresh();
    void this.d.runTurn(text).catch(() => undefined).then(() => {
      if (gen !== this.gen) return;
      this.busy = false;
      this.refresh();
    });
  }
}
