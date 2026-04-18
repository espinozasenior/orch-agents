/**
 * Setup Types.
 *
 * Defines the terminal IO abstractions and repo setup options
 * used by the setup CLI commands.
 */

// ---------------------------------------------------------------------------
// Repo setup options
// ---------------------------------------------------------------------------

export interface RepoSetupOptions {
  repoFullName: string;
  serverUrl?: string;
}

// ---------------------------------------------------------------------------
// Terminal IO abstraction (testability seam)
// ---------------------------------------------------------------------------

export interface KeyPress {
  name: string;       // 'up', 'down', 'space', 'return', 'escape', or character
  ctrl: boolean;
  shift: boolean;
}

export interface TerminalIO {
  write(text: string): void;
  readKey(): Promise<KeyPress>;
  clearScreen(): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Prompt descriptors (pure data structures)
// ---------------------------------------------------------------------------

export interface SelectItem<T = string> {
  value: T;
  label: string;
  description?: string;
  selected: boolean;
}
