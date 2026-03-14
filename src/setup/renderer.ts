/**
 * Terminal Renderer.
 *
 * ANSI-based interactive select/multi-select/numeric components.
 * Uses Node.js built-in readline for raw keypress capture.
 * Zero external dependencies.
 */

import { createInterface, type Interface } from 'node:readline';
import type { TerminalIO, KeyPress, SelectItem } from './types';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  white: '\x1b[37m',
  cursorUp: (n: number) => `\x1b[${n}A`,
  clearLine: '\x1b[2K\r',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

// ---------------------------------------------------------------------------
// Real terminal IO implementation
// ---------------------------------------------------------------------------

export function createTerminalIO(): TerminalIO {
  const stdin = process.stdin;
  const stdout = process.stdout;

  let rl: Interface | undefined;

  if (stdin.isTTY) {
    stdin.setRawMode(true);
    rl = createInterface({ input: stdin, output: stdout, terminal: true });
  }

  return {
    write(text: string) {
      stdout.write(text);
    },
    readKey(): Promise<KeyPress> {
      return new Promise((resolve) => {
        const onData = (data: Buffer) => {
          stdin.removeListener('end', onEnd);
          const s = data.toString();
          const key: KeyPress = { name: '', ctrl: false, shift: false };

          if (s === '\x1b[A') key.name = 'up';
          else if (s === '\x1b[B') key.name = 'down';
          else if (s === ' ') key.name = 'space';
          else if (s === '\r' || s === '\n') key.name = 'return';
          else if (s === '\x1b' || s === 'q') key.name = 'escape';
          else if (s === '\x03') { key.name = 'c'; key.ctrl = true; }
          else if (s === 'a') key.name = 'a';
          else key.name = s;

          resolve(key);
        };
        const onEnd = () => {
          stdin.removeListener('data', onData);
          resolve({ name: 'escape', ctrl: false, shift: false });
        };
        stdin.once('data', onData);
        stdin.once('end', onEnd);
      });
    },
    clearScreen() {
      stdout.write('\x1b[2J\x1b[H');
    },
    close() {
      stdout.write(ANSI.showCursor);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      rl?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering functions
// ---------------------------------------------------------------------------

function renderHeader(io: TerminalIO, title: string, hint?: string): number {
  let lines = 0;
  io.write(`\n${ANSI.bold}${ANSI.cyan}  ${title}${ANSI.reset}\n`);
  lines += 2;
  if (hint) {
    io.write(`${ANSI.dim}  ${hint}${ANSI.reset}\n`);
    lines += 1;
  }
  io.write('\n');
  lines += 1;
  return lines;
}

function renderItems(io: TerminalIO, items: SelectItem[], cursor: number, multi: boolean): number {
  let lines = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isCursor = i === cursor;
    const prefix = isCursor ? `${ANSI.cyan}  > ` : '    ';
    const check = multi
      ? (item.selected ? `${ANSI.green}[x]` : `${ANSI.dim}[ ]`)
      : (item.selected ? `${ANSI.green}(*)` : `${ANSI.dim}( )`);
    const label = isCursor ? `${ANSI.white}${ANSI.bold}${item.label}` : `${item.label}`;
    const desc = item.description ? ` ${ANSI.dim}— ${item.description}` : '';
    io.write(`${prefix}${check} ${label}${desc}${ANSI.reset}\n`);
    lines += 1;
  }
  return lines;
}

function clearRendered(io: TerminalIO, lineCount: number): void {
  for (let i = 0; i < lineCount; i++) {
    io.write(ANSI.cursorUp(1) + ANSI.clearLine);
  }
}

// ---------------------------------------------------------------------------
// Interactive components
// ---------------------------------------------------------------------------

/**
 * Single-select: arrow keys to move, Enter to confirm.
 */
export async function singleSelect<T extends string>(
  io: TerminalIO,
  title: string,
  items: SelectItem<T>[],
  hint?: string,
): Promise<T> {
  io.write(ANSI.hideCursor);
  let cursor = items.findIndex(i => i.selected);
  if (cursor < 0) cursor = 0;
  let rendered = 0;

  const draw = () => {
    if (rendered > 0) clearRendered(io, rendered);
    rendered = 0;
    rendered += renderHeader(io, title, hint);
    rendered += renderItems(io, items as SelectItem[], cursor, false);
    io.write('\n');
    rendered += 1;
  };

  draw();

  while (true) {
    const key = await io.readKey();
    if (key.ctrl && key.name === 'c') {
      io.write(ANSI.showCursor);
      throw new Error('User cancelled');
    }
    if (key.name === 'up' && cursor > 0) {
      cursor--;
      draw();
    } else if (key.name === 'down' && cursor < items.length - 1) {
      cursor++;
      draw();
    } else if (key.name === 'return') {
      io.write(ANSI.showCursor);
      return items[cursor].value;
    } else if (key.name === 'escape') {
      io.write(ANSI.showCursor);
      throw new Error('User cancelled');
    }
  }
}

/**
 * Multi-select: arrows to move, Space to toggle, 'a' to toggle all, Enter to confirm.
 */
export async function multiSelect<T extends string>(
  io: TerminalIO,
  title: string,
  items: SelectItem<T>[],
  hint?: string,
): Promise<T[]> {
  io.write(ANSI.hideCursor);
  // Clone items to avoid mutating the caller's array
  const local = items.map(i => ({ ...i }));
  let cursor = 0;
  let rendered = 0;

  const draw = () => {
    if (rendered > 0) clearRendered(io, rendered);
    rendered = 0;
    rendered += renderHeader(io, title, hint || 'Space=toggle  a=all  Enter=confirm');
    rendered += renderItems(io, local as SelectItem[], cursor, true);
    io.write('\n');
    rendered += 1;
  };

  draw();

  while (true) {
    const key = await io.readKey();
    if (key.ctrl && key.name === 'c') {
      io.write(ANSI.showCursor);
      throw new Error('User cancelled');
    }
    if (key.name === 'up' && cursor > 0) {
      cursor--;
      draw();
    } else if (key.name === 'down' && cursor < local.length - 1) {
      cursor++;
      draw();
    } else if (key.name === 'space') {
      local[cursor].selected = !local[cursor].selected;
      draw();
    } else if (key.name === 'a') {
      const allSelected = local.every(i => i.selected);
      local.forEach(i => { i.selected = !allSelected; });
      draw();
    } else if (key.name === 'return') {
      io.write(ANSI.showCursor);
      return local.filter(i => i.selected).map(i => i.value);
    } else if (key.name === 'escape') {
      io.write(ANSI.showCursor);
      throw new Error('User cancelled');
    }
  }
}

/**
 * Numeric input: type digits, Enter to confirm, validates min/max.
 */
export async function numericInput(
  io: TerminalIO,
  title: string,
  min: number,
  max: number,
  defaultValue: number,
): Promise<number> {
  io.write(ANSI.hideCursor);
  let value = String(defaultValue);
  let rendered = 0;
  let error = '';

  const draw = () => {
    if (rendered > 0) clearRendered(io, rendered);
    rendered = 0;
    rendered += renderHeader(io, title, `Range: ${min}-${max}, Enter to confirm`);
    io.write(`    ${ANSI.cyan}>${ANSI.reset} ${value}${value ? '' : ANSI.dim + String(defaultValue) + ANSI.reset}\n`);
    rendered += 1;
    if (error) {
      io.write(`    ${ANSI.yellow}${error}${ANSI.reset}\n`);
      rendered += 1;
    }
    io.write('\n');
    rendered += 1;
  };

  draw();

  while (true) {
    const key = await io.readKey();
    if (key.ctrl && key.name === 'c') {
      io.write(ANSI.showCursor);
      throw new Error('User cancelled');
    }
    if (key.name === 'return') {
      const num = parseInt(value || String(defaultValue), 10);
      if (isNaN(num) || num < min || num > max) {
        error = `Must be between ${min} and ${max}`;
        draw();
        continue;
      }
      io.write(ANSI.showCursor);
      return num;
    } else if (key.name === 'escape') {
      io.write(ANSI.showCursor);
      throw new Error('User cancelled');
    } else if (key.name === '\x7f' || key.name === '\b') {
      // backspace
      value = value.slice(0, -1);
      error = '';
      draw();
    } else if (/^\d$/.test(key.name)) {
      value += key.name;
      error = '';
      draw();
    }
  }
}
