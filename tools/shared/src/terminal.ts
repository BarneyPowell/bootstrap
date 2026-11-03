import { paint, palette } from './gum.ts';

export const colour = (stream: NodeJS.WriteStream) => !!stream.isTTY && !process.env.NO_COLOR;

// A spinner on stderr while slow work runs. It draws nothing unless stderr is a terminal.
export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private timer?: NodeJS.Timeout;
  private text = '';
  private index = 0;
  private stream: NodeJS.WriteStream;
  constructor(stream: NodeJS.WriteStream = process.stderr) {
    this.stream = stream;
  }

  update(text: string): void {
    if (!this.stream.isTTY) return;
    this.text = text;
    if (!this.timer) {
      this.stream.write('\x1b[?25l');
      this.timer = setInterval(() => this.draw(), 80);
    }
    this.draw();
  }

  private draw(): void {
    const frame = this.frames[this.index++ % this.frames.length];
    const line = colour(this.stream)
      ? `${paint(palette.accent, frame)} ${paint(palette.dim, this.text)}`
      : `${frame} ${this.text}`;
    this.stream.write(`\r\x1b[2K${line}`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream.write('\r\x1b[2K\x1b[?25h');
  }
}
