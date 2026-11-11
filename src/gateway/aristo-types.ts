// The three aristo-v2 protocol.ts types the glasses contract imports, copied verbatim so the
// vendored contract compiles here. `npm run contract:check` compares them with the source.

export type SessionStatus = 'working' | 'waiting' | 'idle' | 'finished' | 'error' | 'background' | 'watching';

export type Priority = 'urgent' | 'high' | 'notification' | 'daily' | 'weekly' | 'silent';

export interface AnswerArgs {
  promptId: string;
  /** Permission prompts: the option number picked. */
  option?: number;
  /** "No, and tell Claude what to do differently" text, or extra context. */
  message?: string;
  /** AskUserQuestion: question text -> chosen label(s) or typed text. */
  answers?: Record<string, string | string[]>;
}
