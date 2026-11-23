export interface GeminiAssistantProviderData {
  gemini: {
    /** Antigravity CLI (ACP) session that holds this point of the conversation. */
    sessionId: string;
    /** Unique per committed point; the session continues only from its newest (prompt.ts). */
    mark: string;
    /** Sessions are loaded in their workspace. */
    cwd: string;
  };
}
