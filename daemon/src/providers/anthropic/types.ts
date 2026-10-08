export interface AnthropicAssistantProviderData {
  anthropic: {
    /** Claude Code session that contains this assistant turn. */
    sessionId: string;
    /** Last chain entry of the turn; later turns fork the session here. */
    resumeAt: string;
    /** Claude Code stores sessions per project directory, so resume needs the same cwd. */
    cwd: string;
  };
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}
